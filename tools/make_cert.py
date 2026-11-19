"""Генерация самоподписанного сертификата с SAN IP:<адрес ПК>."""

from __future__ import annotations

import argparse
import datetime
import ipaddress
import json
import socket
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

BASE_DIR = Path(__file__).resolve().parent.parent


def guess_ip() -> str:
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
        s.close()
        return ip
    except OSError:
        return "127.0.0.1"


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--ip", default=None, help="IP ПК в локальной сети")
    parser.add_argument("--force", action="store_true", help="перезаписать сертификат")
    args = parser.parse_args()

    cfg_path = BASE_DIR / "config.json"
    cfg = json.loads(cfg_path.read_text(encoding="utf-8")) if cfg_path.exists() else {}
    ip = args.ip or cfg.get("ip") or guess_ip()

    cert_dir = BASE_DIR / "cert"
    cert_path = cert_dir / "cert.pem"
    key_path = cert_dir / "key.pem"
    if (cert_path.exists() or key_path.exists()) and not args.force:
        print(f"Сертификат уже есть: {cert_path}\nИспользуйте --force для перезаписи.")
        return

    cert_dir.mkdir(exist_ok=True)
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, ip)])
    now = datetime.datetime.now(datetime.timezone.utc)
    alt = [x509.IPAddress(ipaddress.ip_address(ip)), x509.DNSName("localhost")]
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=3650))
        .add_extension(x509.SubjectAlternativeName(alt), critical=False)
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(key, hashes.SHA256())
    )
    key_path.write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption(),
        )
    )
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    print(f"Готово. IP в сертификате: {ip}")
    print(f"{cert_path}\n{key_path}")


if __name__ == "__main__":
    main()
