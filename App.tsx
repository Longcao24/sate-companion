import React, { useMemo, useState } from "react";
import { StatusBar } from "expo-status-bar";
import { View } from "react-native";
import { makeApi } from "./src/api/sateApi";
import { makeLink } from "./src/ble/SateBle";
import { ManagedDevice } from "./src/protocol";
import { DevicePreviewScreen } from "./src/screens/DevicePreviewScreen";
import { HomeScreen } from "./src/screens/HomeScreen";
import { LoginScreen } from "./src/screens/LoginScreen";
import { ProvisionScreen } from "./src/screens/ProvisionScreen";
import { RecorderSettingsScreen } from "./src/screens/RecorderSettingsScreen";
import { SettingsScreen } from "./src/screens/SettingsScreen";
import { StoreProvider, useStore } from "./src/store";
import { useAutoSync } from "./src/sync/AutoSync";
import { D } from "./src/theme";

type Screen =
  | { name: "home" }
  | { name: "provision" }
  | { name: "recorderSettings"; device: ManagedDevice }
  | { name: "preview" }
  | { name: "settings" };

function Root() {
  const { settings, ready } = useStore();
  const [screen, setScreen] = useState<Screen>({ name: "home" });

  const api = useMemo(
    () => makeApi(settings.serverUrl, settings.token),
    [settings.serverUrl, settings.token]
  );
  const link = useMemo(() => makeLink(), []);

  // Background BLE bridge runs while signed in + enabled, except where a screen
  // needs exclusive use of the radio (first-time setup or a recorder restart).
  const syncEnabled =
    settings.autoSync &&
    screen.name !== "provision" &&
    screen.name !== "recorderSettings";
  // Kept mounted so the background BLE bridge keeps running across screens.
  useAutoSync(syncEnabled, link, api, !!settings.token);

  if (!ready) return <View style={{ flex: 1, backgroundColor: D.bg }} />;
  if (!settings.token) {
    return (
      <>
        <StatusBar style="light" />
        <LoginScreen />
      </>
    );
  }

  return (
    <>
      <StatusBar style="light" />
      {screen.name === "home" && (
        <HomeScreen
          api={api}
          link={link}
          onOpenSettings={() => setScreen({ name: "settings" })}
          onOpenPreview={() => setScreen({ name: "preview" })}
          onSetupNew={() => setScreen({ name: "provision" })}
          onOpenRecorderSettings={(device) =>
            setScreen({ name: "recorderSettings", device })
          }
        />
      )}
      {screen.name === "recorderSettings" && (
        <RecorderSettingsScreen
          api={api}
          link={link}
          device={screen.device}
          onClose={() => setScreen({ name: "home" })}
          onUnlinked={() => setScreen({ name: "home" })}
        />
      )}
      {screen.name === "provision" && (
        <ProvisionScreen
          api={api}
          link={link}
          onClose={() => setScreen({ name: "home" })}
        />
      )}
      {screen.name === "preview" && (
        <DevicePreviewScreen onClose={() => setScreen({ name: "home" })} />
      )}
      {screen.name === "settings" && (
        <SettingsScreen onClose={() => setScreen({ name: "home" })} />
      )}
    </>
  );
}

export default function App() {
  return (
    <StoreProvider>
      <Root />
    </StoreProvider>
  );
}
