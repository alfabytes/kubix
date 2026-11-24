import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ResourceDetail } from "@/components/explorer/resource-detail";
import { setIpcTransport, tauriTransport, type IpcTransport } from "@/lib/ipc/client";

const { editorSpy } = vi.hoisted(() => ({ editorSpy: vi.fn() }));
vi.mock("@monaco-editor/react", () => ({
  default: (props: unknown) => {
    editorSpy(props);
    return <div data-testid="editor" />;
  },
}));

afterEach(() => {
  setIpcTransport(tauriTransport);
  editorSpy.mockClear();
});

describe("resource inspector", () => {
  it("keeps masked YAML read-only in the selected theme", async () => {
    const commands: string[] = [];
    setIpcTransport({
      invoke: (async (command: string) => {
        commands.push(command);
        return {
          contextId: "kind-dev", gvr: "/v1/secrets", name: "db", namespace: "default",
          yaml: "kind: Secret\ndata:\n  password: <masked by kubix>",
          maskedPaths: ["/data/password"],
        };
      }) as IpcTransport["invoke"],
      listen: (async () => () => {}) as IpcTransport["listen"],
    });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <ResourceDetail contextId="kind-dev" gvr="/v1/secrets" name="db" namespace="default" theme="light" onClose={() => {}} />
      </QueryClientProvider>,
    );

    expect(await screen.findByTestId("masked-banner")).toHaveTextContent("/data/password");
    expect(editorSpy).toHaveBeenCalledWith(expect.objectContaining({
      theme: "vs",
      options: expect.objectContaining({ readOnly: true, domReadOnly: true }),
      value: expect.stringContaining("<masked by kubix>"),
    }));
    expect(commands).toEqual(["get_resource"]);
  });
});
