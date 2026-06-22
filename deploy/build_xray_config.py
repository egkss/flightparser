from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse
from uuid import UUID


def build_config(vless_url: str) -> dict:
    parsed = urlparse(vless_url.strip())
    query = {key: values[-1] for key, values in parse_qs(parsed.query).items()}

    if parsed.scheme != "vless":
        raise ValueError("VLESS_URL должен начинаться с vless://")
    if not parsed.hostname or not parsed.port or not parsed.username:
        raise ValueError("VLESS_URL не содержит UUID, адрес или порт")
    UUID(parsed.username)
    if query.get("security") != "reality":
        raise ValueError("Поддерживается VLESS только с security=reality")
    for field in ("pbk", "sni", "sid"):
        if not query.get(field):
            raise ValueError(f"VLESS_URL не содержит параметр {field}")

    user = {
        "id": parsed.username,
        "encryption": query.get("encryption", "none"),
    }
    if query.get("flow"):
        user["flow"] = query["flow"]

    return {
        "log": {"loglevel": "warning"},
        "inbounds": [
            {
                "tag": "telegram-http-proxy",
                "listen": "0.0.0.0",
                "port": 1080,
                "protocol": "http",
                "settings": {},
            }
        ],
        "outbounds": [
            {
                "tag": "vless-out",
                "protocol": "vless",
                "settings": {
                    "vnext": [
                        {
                            "address": parsed.hostname,
                            "port": parsed.port,
                            "users": [user],
                        }
                    ]
                },
                "streamSettings": {
                    "network": query.get("type", "tcp"),
                    "security": "reality",
                    "realitySettings": {
                        "fingerprint": query.get("fp", "chrome"),
                        "serverName": query["sni"],
                        "password": query["pbk"],
                        "shortId": query["sid"],
                        "spiderX": unquote(query.get("spx", "/")),
                    },
                },
            }
        ],
    }


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: build_xray_config.py OUTPUT_PATH")
    vless_url = os.environ.get("VLESS_URL", "")
    if not vless_url:
        raise SystemExit("VLESS_URL не задан")

    output_path = Path(sys.argv[1])
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(build_config(vless_url), ensure_ascii=False, indent=2), encoding="utf-8")
    output_path.chmod(0o644)


if __name__ == "__main__":
    main()
