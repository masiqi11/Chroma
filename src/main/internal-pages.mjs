import { protocol } from "electron";

function configuredSearchAction() {
  try {
    const url = new URL(
      process.env.CHROMA_SEARCH_URL || "https://www.google.com/search"
    );
    if (url.protocol === "http:" || url.protocol === "https:") return url;
  } catch {
    // Fall through to the built-in provider.
  }
  return new URL("https://www.google.com/search");
}

const searchActionUrl = configuredSearchAction();
const searchActionAttribute = searchActionUrl.href
  .replaceAll("&", "&amp;")
  .replaceAll('"', "&quot;");

const newTabHtml = String.raw`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'; form-action ${searchActionUrl.origin}"
    />
    <title>New Tab</title>
    <style>
      :root { color-scheme: light dark; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        color: rgba(250, 248, 255, .92);
        background:
          radial-gradient(circle at 28% 15%, rgba(166, 109, 204, .32), transparent 38%),
          radial-gradient(circle at 78% 86%, rgba(77, 127, 178, .24), transparent 44%),
          linear-gradient(145deg, #17131d, #11131a 58%, #111824);
        overflow: hidden;
      }
      body::after {
        content: "";
        position: fixed;
        inset: 0;
        pointer-events: none;
        opacity: .04;
        background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 140 140' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.85' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='.7'/%3E%3C/svg%3E");
      }
      main { width: min(620px, calc(100vw - 52px)); text-align: center; transform: translateY(-4vh); }
      #clock { font-size: clamp(64px, 10vw, 108px); font-weight: 260; letter-spacing: -.07em; line-height: 1; }
      #date { margin: 13px 0 34px; color: rgba(245, 242, 250, .58); font-size: 15px; }
      form {
        display: flex;
        align-items: center;
        height: 52px;
        padding: 0 17px;
        border: 1px solid rgba(255,255,255,.12);
        border-radius: 17px;
        background: rgba(255,255,255,.075);
        box-shadow: 0 15px 50px rgba(0,0,0,.22), inset 0 1px rgba(255,255,255,.05);
        backdrop-filter: blur(22px);
      }
      form::before { content: "⌕"; color: rgba(255,255,255,.56); font-size: 24px; margin-right: 10px; transform: rotate(-20deg); }
      input {
        width: 100%; border: 0; outline: 0; color: inherit; background: transparent;
        font: inherit; font-size: 15px;
      }
      input::placeholder { color: rgba(255,255,255,.42); }
    </style>
  </head>
  <body>
    <main>
      <div id="clock">--:--</div>
      <div id="date"></div>
      <form action="${searchActionAttribute}" method="get">
        <input name="q" type="search" autocomplete="off" placeholder="Search the web" aria-label="Search the web" />
      </form>
    </main>
    <script>
      const clock = document.querySelector('#clock');
      const date = document.querySelector('#date');
      const update = () => {
        const now = new Date();
        clock.textContent = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false }).format(now);
        date.textContent = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(now);
      };
      update();
      setInterval(update, 1000);
    </script>
  </body>
</html>`;

const notFoundHtml = `<!doctype html><meta charset="utf-8"><title>Not found</title><style>body{font:16px system-ui;background:#16131c;color:#eee;padding:48px}</style><h1>Chroma page not found</h1>`;

export function registerInternalScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: "chroma",
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: false,
      },
    },
  ]);
}

export function installInternalProtocol(protocolApi = protocol) {
  if (protocolApi.isProtocolHandled("chroma")) return;
  protocolApi.handle("chroma", request => {
    const url = new URL(request.url);
    const html = url.hostname === "newtab" ? newTabHtml : notFoundHtml;
    return new Response(html, {
      status: url.hostname === "newtab" ? 200 : 404,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  });
}
