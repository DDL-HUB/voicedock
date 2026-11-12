"""Create a local pairing code and save the API key for this Windows user."""
import getpass
import os
import secrets

import cloud_credentials
import cloud_provider
from server import PAIRING_FILE


def main():
    if os.name != 'nt':
        raise SystemExit('此配置工具使用 Windows 凭据加密。')
    key = getpass.getpass('粘贴阿里云百炼 API Key（输入不显示）: ').strip()
    if not key or any(character.isspace() for character in key):
        raise SystemExit('请输入有效的 API Key。')
    cloud_credentials.save([key])
    options = cloud_provider.config()
    options.update(enabled=True, model='cosyvoice-v3.5-flash', key_index=0)
    cloud_provider.save_config(options)
    if not PAIRING_FILE.exists():
        PAIRING_FILE.write_text(secrets.token_urlsafe(32), encoding='ascii')
    print('在扩展设置中粘贴这个本机连接码，再运行 start-cloud.cmd。')
    print(PAIRING_FILE.read_text(encoding='ascii').strip())


if __name__ == '__main__':
    main()
