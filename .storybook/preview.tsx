import { useEffect } from "react";
import type { ReactNode } from "react";
import type { Preview } from "@storybook/react-vite";
import { applyTheme } from "../src/lib/theme";
import { ACCENTS } from "../src/lib/types";
import "../src/styles.css";

function AppTheme({ theme, fullscreen, children }: { theme: unknown; fullscreen: boolean; children: ReactNode }) {
  useEffect(() => { applyTheme(theme === "light" ? "light" : theme === "glass" ? "glass" : theme === "terminal" ? "terminal" : theme === "macintosh" ? "macintosh" : "dark", ACCENTS[0].value); }, [theme]);
  return <div style={{ padding: fullscreen ? 0 : 16 }}>{children}</div>;
}
const preview: Preview = {
  initialGlobals: { theme: "dark" },
  globalTypes: {
    theme: { description: "App theme", toolbar: { icon: "paintbrush", dynamicTitle: true,
      items: [{ value: "dark", title: "Dark" }, { value: "light", title: "Light" }, { value: "glass", title: "Glass" }, { value: "terminal", title: "Wasteland Terminal" }, { value: "macintosh", title: "Classic Macintosh" }] } },
  },
  decorators: [(Story, context) => <AppTheme theme={context.globals.theme} fullscreen={context.parameters.layout === "fullscreen"}><Story /></AppTheme>],
};
export default preview;
