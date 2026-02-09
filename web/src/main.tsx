import "./styles/globals.css";

type VsCodeApi = {
  postMessage: (msg: unknown) => void;
  getState: <T>() => T | undefined;
  setState: <T>(state: T) => T;
};

declare global {
  // eslint-disable-next-line no-var
  var acquireVsCodeApi: undefined | (() => VsCodeApi);
}

function createBridge(): VsCodeApi {
  const stateKey = "acp-chat.webviewState";
  const pending: string[] = [];

  const token = (() => {
    try {
      const u = new URL(window.location.href);
      const t = u.searchParams.get("token");
      return t && t.trim() ? t.trim() : "";
    } catch {
      return "";
    }
  })();

  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  const wsUrl = `${proto}://${window.location.host}/ws${token ? `?token=${encodeURIComponent(token)}` : ""}`;
  const ws = new WebSocket(wsUrl);

  const flush = () => {
    while (pending.length > 0 && ws.readyState === WebSocket.OPEN) {
      const item = pending.shift();
      if (item) ws.send(item);
    }
  };

  ws.addEventListener("open", () => {
    flush();
  });

  ws.addEventListener("message", (evt) => {
    try {
      const data = JSON.parse(String(evt.data));
      window.dispatchEvent(new MessageEvent("message", { data }));
    } catch {
      // ignore
    }
  });

  return {
    postMessage: (msg: unknown) => {
      const payload = JSON.stringify(msg ?? null);
      if (ws.readyState === WebSocket.OPEN) ws.send(payload);
      else pending.push(payload);
    },
    getState: <T,>() => {
      try {
        const raw = localStorage.getItem(stateKey);
        return raw ? (JSON.parse(raw) as T) : undefined;
      } catch {
        return undefined;
      }
    },
    setState: <T,>(state: T) => {
      try {
        localStorage.setItem(stateKey, JSON.stringify(state));
      } catch {
        // ignore
      }
      return state;
    },
  };
}

// Install a VS Code webview bridge so we can reuse the same UI logic.
globalThis.acquireVsCodeApi = createBridge;

// Render after the bridge is installed (some modules read VS Code API at import time).
void import("react").then(({ default: React }) =>
  import("react-dom/client").then(({ default: ReactDOM }) =>
    import("./App").then(({ App }) => {
      ReactDOM.createRoot(document.getElementById("root")!).render(
        <React.StrictMode>
          <App />
        </React.StrictMode>
      );
    })
  )
);
