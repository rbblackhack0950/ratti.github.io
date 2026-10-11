"""Builds multikick-single.html: the whole app inlined into one file you can download and open."""
from pathlib import Path

here = Path(__file__).parent
html = (here / 'index.html').read_text()
css = (here / 'style.css').read_text()
js = (here / 'app.js').read_text()
for tag in ('  <link rel="manifest" href="manifest.webmanifest">\n',
            '  <link rel="icon" href="icon.svg" type="image/svg+xml">\n',
            '  <link rel="apple-touch-icon" href="icon-192.png">\n'):
    html = html.replace(tag, '')
html = html.replace('<link rel="stylesheet" href="style.css">', '<style>\n' + css + '</style>')
html = html.replace('<script src="app.js"></script>', '<script>\n' + js + '</script>')
(here / 'multikick-single.html').write_text(html)
