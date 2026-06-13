import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  ReactNode,
} from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { User } from "./protocol";

export interface Settings {
  serverUrl: string;
  token: string | null;
  user: User | null;
  autoSync: boolean;
}

const DEFAULTS: Settings = {
  // Real SATE server. In dev this is the mock-server on the Mac's LAN IP - the
  // board hits the SAME URL over Wi-Fi to register, so it can't be localhost.
  serverUrl: "http://192.168.0.138:4000",
  token: null,
  user: null,
  autoSync: true,
};

interface Store {
  settings: Settings;
  ready: boolean;
  update: (patch: Partial<Settings>) => void;
  signOut: () => void;
}

const Ctx = createContext<Store | null>(null);
// v2: dropped demo mode; bump invalidates any stale demo token / server URL.
const KEY = "sate-companion-settings-v2";

export function StoreProvider({ children }: { children: ReactNode }) {
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    AsyncStorage.getItem(KEY)
      .then((raw) => {
        if (raw) setSettings({ ...DEFAULTS, ...JSON.parse(raw) });
      })
      .finally(() => setReady(true));
  }, []);

  const update = (patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      AsyncStorage.setItem(KEY, JSON.stringify(next)).catch(() => {});
      return next;
    });
  };

  const signOut = () => update({ token: null, user: null });

  return (
    <Ctx.Provider value={{ settings, ready, update, signOut }}>
      {children}
    </Ctx.Provider>
  );
}

export function useStore(): Store {
  const s = useContext(Ctx);
  if (!s) throw new Error("useStore outside StoreProvider");
  return s;
}
