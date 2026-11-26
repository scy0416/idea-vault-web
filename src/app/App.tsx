import { useEffect, useState } from "react";
import { openStore, type Store } from "../storage/store.ts";
import { SettingsScreen } from "./SettingsScreen.tsx";
import { Vault } from "./Vault.tsx";

export function App({ open = openStore }: { open?: () => Promise<Store> }) {
  const [store, setStore] = useState<Store | null>(null);
  const [failed, setFailed] = useState(false);
  const [settings, setSettings] = useState(false);

  useEffect(() => {
    let closed = false;
    let opened: Store | undefined;
    open().then(
      (s) => {
        if (closed) return s.close();
        opened = s;
        setStore(s);
      },
      () => setFailed(true),
    );
    return () => {
      closed = true;
      opened?.close();
    };
  }, [open]);

  return (
    <main>
      <header>
        <h1>아이디어 볼트</h1>
        <button type="button" disabled={!store} onClick={() => setSettings((v) => !v)}>
          {settings ? "닫기" : "설정"}
        </button>
      </header>
      {failed && (
        <p className="notice error" role="alert">
          이 브라우저에 저장할 수 없습니다. 사생활 보호 모드나 저장 차단 설정을 확인하세요.
        </p>
      )}
      {store && settings && <SettingsScreen store={store} />}
      {store && <Vault store={store} hidden={settings} />}
    </main>
  );
}
