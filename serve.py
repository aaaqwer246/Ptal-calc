"""仅在本机提供计算器静态页面，不转发请求或保存地图数据。"""
import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlsplit
import webbrowser

ROOT = Path(__file__).resolve().parent
HOST, PORT = '127.0.0.1', 8765
PUBLIC_FILES = {ROOT / 'index.html', ROOT / 'styles.css', *(ROOT / 'src').glob('*.js')}


class Handler(SimpleHTTPRequestHandler):
    def send_head(self):
        if self.headers.get('Host') not in (f'{HOST}:{PORT}', f'localhost:{PORT}'):
            self.send_error(403)
            return None
        name = unquote(urlsplit(self.path).path).lstrip('/') or 'index.html'
        if (ROOT / name).resolve() not in PUBLIC_FILES:
            self.send_error(404)
            return None
        return super().send_head()

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        super().end_headers()


def main():
    parser = argparse.ArgumentParser(description='启动本地公共交通可达性计算器')
    parser.add_argument('--no-browser', action='store_true')
    args = parser.parse_args()
    try:
        server = ThreadingHTTPServer((HOST, PORT), partial(Handler, directory=str(ROOT)))
    except OSError as error:
        print(f'启动失败：{error}\n请关闭占用 {PORT} 端口的程序后重试。')
        return 1
    url = f'http://{HOST}:{PORT}/'
    print(f'本地计算器：{url}\n使用期间请保持此窗口打开，按 Ctrl+C 关闭。', flush=True)
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
