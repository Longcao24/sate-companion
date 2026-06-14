import React, {
  createContext,
  useContext,
  useEffect,
  useState,
  ReactNode,
} from "react";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { User } from "./protocol";
import { DEVICE_API_URL } from "./api/sateApi";

export interface Settings {
  serverUrl: string;
  token: string | null;
  user: User | null;
  autoSync: boolean;
}

const DEFAULTS: Settings = {
  // Production SATE backend: the Supabase `device-api` Edge Function. The
  // recorder is provisioned with this SAME URL, so it registers + auto-claims to
  // the signed-in account. (Override with a mock-server URL on the Login screen
  // for local dev.)
  serverUrl: DEVICE_API_URL,
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
// v3: default server is now the Supabase device-api; bump invalidates any stale
// mock-server URL / token saved under v2.
const KEY = "sate-companion-settings-v3";

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
