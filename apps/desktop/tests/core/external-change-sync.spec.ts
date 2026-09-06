import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { expect, test } from "@playwright/test";
import {
  createNamedThread,
  addWorkspaceViaIpc,
  getDesktopState,
  launchDesktop,
  makeUserDataDir,
  makeWorkspace,
  triggerWindowActivation,
} from "../helpers/electron-app";
import {
  appendMessagesToSessionFile,
  createSessionFileBeside,
  sessionFilePathFromCatalog,
} from "../helpers/session-file";

/**
 * Acceptance test for CLI ↔ GUI sync in the Codex-style model (no live file
 * watcher). With the app running and a session selected, an external writer (the
 * pi CLI) appends a turn straight to the pi session JSONL. On the next window
 * focus, the app reconciles from disk and re-renders the selected transcript —
 * WITHOUT the user re-selecting the workspace or session.
 */
test("discovers an unregistered CLI cwd and persists Remove without deleting its session", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const cwd = await makeWorkspace("discovered-cli");
  const sessionDir = join(userDataDir, "agent", "sessions", "--fixture--");
  await mkdir(sessionDir, { recursive: true });
  const sessionFile = join(sessionDir, "cli.jsonl");
  await writeFile(sessionFile, JSON.stringify({type: "session", version: 3, id: "discovered-cli", cwd, timestamp: new Date().toISOString()}) + "\n");
  await appendMessagesToSessionFile(sessionFile, [{role: "user", text: "CLI discovery evidence"}]);
  await writeFile(join(sessionDir, "broken.jsonl"), "not json\n");
  let harness = await launchDesktop(userDataDir, {initialWorkspaces: [], testMode: "background"});
  try {
    const window = await harness.firstWindow();
    await expect.poll(async () => (await getDesktopState(window)).workspaces.find(w => w.path === cwd)?.sessions.length).toBe(1);
    window.once("dialog", dialog => void dialog.accept());
    await window.getByRole("button", {name: `Workspace actions for ${basename(cwd)}`}).click();
    await window.locator(".workspace-menu").last().getByRole("button", {name: "Remove", exact: true}).click();
    await expect.poll(async () => (await getDesktopState(window)).workspaces.some(w => w.path === cwd)).toBe(false);
  } finally { await harness.close(); }
  harness = await launchDesktop(userDataDir, {initialWorkspaces: [], testMode: "background"});
  try {
    const window = await harness.firstWindow();
    expect((await getDesktopState(window)).workspaces.some(w => w.path === cwd)).toBe(false);
    expect(await readFile(sessionFile, "utf8")).toContain("CLI discovery evidence");
    // Folder picker is native-lane coverage; reuse its existing IPC helper here.
    await addWorkspaceViaIpc(window, cwd);
    await expect.poll(async () => (await getDesktopState(window)).workspaces.find(w => w.path === cwd)?.sessions.length).toBe(1);
    const persisted = JSON.parse(await readFile(join(userDataDir, "ui-state.json"), "utf8"));
    expect(persisted.ignoredWorkspacePaths).not.toContain(cwd);
  } finally { await harness.close(); }
});

test("reflects an external append to the selected session's JSONL on window focus", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("cli-sync-workspace");

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    await createNamedThread(window, "CLI sync session");

    const state = await getDesktopState(window);
    const workspaceId = state.selectedWorkspaceId;
    const sessionId = state.selectedSessionId;
    expect(workspaceId).toBeTruthy();
    expect(sessionId).toBeTruthy();

    // Resolve the pi JSONL path from the catalog once the running app has written it.
    let sessionFilePath = "";
    await expect
      .poll(
        async () => {
          try {
            sessionFilePath = await sessionFilePathFromCatalog(userDataDir, { workspaceId, sessionId });
            const contents = await readFile(sessionFilePath, "utf8");
            return contents.split("\n").filter(Boolean).length;
          } catch {
            return 0;
          }
        },
        { timeout: 20_000 },
      )
      .toBeGreaterThan(0);

    // Append a turn exactly as the pi CLI would, chaining off the current leaf.
    // No workspace/session re-selection happens after this point.
    await appendMessagesToSessionFile(sessionFilePath, [
      { role: "user", text: "external CLI turn appears on focus" },
    ]);

    // The append alone must not update the view — sync is focus-driven now.
    await expect(window.getByTestId("transcript")).not.toContainText("external CLI turn appears on focus");

    // Returning focus to the window reconciles from disk and republishes the transcript.
    await triggerWindowActivation(harness);

    await expect(window.getByTestId("transcript")).toContainText("external CLI turn appears on focus", {
      timeout: 20_000,
    });

    // The selection must be untouched — the update came from the focus reconcile, not a reselect.
    const afterState = await getDesktopState(window);
    expect(afterState.selectedWorkspaceId).toBe(workspaceId);
    expect(afterState.selectedSessionId).toBe(sessionId);
  } finally {
    await harness.close();
  }
});

/**
 * A CLI-created session (a brand-new JSONL the GUI has never seen) must surface
 * in the sidebar after the next window focus, without a workspace re-select.
 */
test("surfaces a CLI-created session on window focus", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("cli-new-session-workspace");

  const harness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });

  try {
    const window = await harness.firstWindow();
    // Seed one GUI session so the workspace has a resolvable pi session dir.
    await createNamedThread(window, "Seed session");

    const state = await getDesktopState(window);
    const workspaceId = state.selectedWorkspaceId;
    const sessionId = state.selectedSessionId;
    expect(workspaceId).toBeTruthy();

    let seedFilePath = "";
    await expect
      .poll(async () => {
        try {
          seedFilePath = await sessionFilePathFromCatalog(userDataDir, { workspaceId, sessionId });
          return (await readFile(seedFilePath, "utf8")).split("\n").filter(Boolean).length;
        } catch {
          return 0;
        }
      }, { timeout: 20_000 })
      .toBeGreaterThan(0);

    // Fabricate a second session's JSONL beside the seed, exactly as the pi CLI would.
    await createSessionFileBeside(seedFilePath, "cli-created-session.jsonl", [
      { role: "user", text: "hello from the pi CLI" },
    ]);

    await triggerWindowActivation(harness);

    await expect
      .poll(async () => {
        const next = await getDesktopState(window);
        const workspace = next.workspaces.find((entry) => entry.id === workspaceId);
        return workspace?.sessions.length ?? 0;
      }, { timeout: 20_000 })
      .toBeGreaterThan(1);
  } finally {
    await harness.close();
  }
});

test("imports a CLI session started below a registered workspace on next launch", async () => {
  test.setTimeout(90_000);
  const userDataDir = await makeUserDataDir();
  const workspacePath = await makeWorkspace("cli-nested-session-workspace");
  const nestedCwd = join(workspacePath, "packages", "api");
  await mkdir(nestedCwd, { recursive: true });

  const firstHarness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath],
    testMode: "background",
  });
  let nestedSessionPath = "";
  try {
    const window = await firstHarness.firstWindow();
    await createNamedThread(window, "Seed parent workspace");
    const state = await getDesktopState(window);
    const seedFilePath = await sessionFilePathFromCatalog(userDataDir, {
      workspaceId: state.selectedWorkspaceId,
      sessionId: state.selectedSessionId,
    });
    const stagedSessionPath = await createSessionFileBeside(
      seedFilePath,
      "cli-created-in-nested-cwd.jsonl",
      [{ role: "user", text: "nested CLI session imported at startup" }],
      { cwd: nestedCwd },
    );
    const encodedCwd = `--${nestedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
    const nestedSessionDir = join(userDataDir, "agent", "sessions", encodedCwd);
    await mkdir(nestedSessionDir, { recursive: true });
    nestedSessionPath = join(nestedSessionDir, "cli-created-in-nested-cwd.jsonl");
    await rename(stagedSessionPath, nestedSessionPath);
  } finally {
    await firstHarness.close();
  }

  const secondHarness = await launchDesktop(userDataDir, {
    initialWorkspaces: [workspacePath, nestedCwd],
    testMode: "background",
  });
  try {
    const window = await secondHarness.firstWindow();
    await expect.poll(async () => {
      const state = await getDesktopState(window);
      const parentWorkspace = state.workspaces.find((entry) => entry.path === workspacePath);
      const nestedWorkspace = state.workspaces.find((entry) => entry.path === nestedCwd);
      if (!parentWorkspace || !nestedWorkspace) {
        return false;
      }
      const nestedPaths = await Promise.all(
        nestedWorkspace.sessions.map((session) => sessionFilePathFromCatalog(userDataDir, {
          workspaceId: nestedWorkspace.id,
          sessionId: session.id,
        })),
      );
      const parentPaths = await Promise.all(
        parentWorkspace.sessions.map((session) => sessionFilePathFromCatalog(userDataDir, {
          workspaceId: parentWorkspace.id,
          sessionId: session.id,
        })),
      );
      return nestedPaths.includes(nestedSessionPath) && !parentPaths.includes(nestedSessionPath);
    }, { timeout: 20_000 }).toBe(true);
  } finally {
    await secondHarness.close();
  }
});
