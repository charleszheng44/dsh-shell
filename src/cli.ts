#!/usr/bin/env node

import {
  Container,
  Editor,
  ProcessTerminal,
  ScrollView,
  Text,
  TuiAltScreen,
  VStack,
  matchesKey,
  type EditorTheme,
} from "@earendil-works/pi-tui";

const identity = (text: string): string => text;

const editorTheme: EditorTheme = {
  borderColor: identity,
  selectList: {
    selectedPrefix: identity,
    selectedText: identity,
    description: identity,
    scrollInfo: identity,
    noMatch: identity,
  },
};

const terminal = new ProcessTerminal();
const tui = new TuiAltScreen(terminal);
const transcript = new Container();

transcript.addChild(new Text("dsh-tui"));
transcript.addChild(
  new Text(
    "Disconnected: deepseek-harness does not yet publish the external client required by this terminal.",
  ),
);

const editor = new Editor(tui, editorTheme, { paddingX: 1 });
editor.disableSubmit = true;

tui.setLayoutRoot(
  new VStack([
    {
      component: new ScrollView(transcript, {
        follow: "end",
        primary: true,
        overscroll: "chain",
      }),
      basis: 0,
      grow: 1,
      minSize: 1,
    },
    {
      component: new VStack([
        editor,
        new Text("Waiting for the DSH client API · Ctrl+C quit"),
      ]),
      basis: "auto",
      shrink: 1,
      minSize: 1,
    },
  ]),
);

const stop = (): void => {
  tui.stop();
};

tui.addInputListener((data) => {
  if (matchesKey(data, "ctrl+c")) {
    stop();
    return { consume: true };
  }

  return undefined;
});

process.once("SIGTERM", stop);

tui.setFocus(editor);
tui.start();
