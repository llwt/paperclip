import { useEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, userEvent, within } from "storybook/test";
import { AiConnectionSetupTokenPaste } from "@/components/ai-connections/AiConnectionRepair";

/** The paste field from the Reconnect dialog; the save request is a fixture. */
function SetupTokenPasteReview() {
  const [client] = useState(() => new QueryClient({ defaultOptions: { mutations: { retry: false } } }));
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    const previous = window.fetch;
    const fixtureFetch: typeof window.fetch = async (input, init) => {
      const path = new URL(input instanceof Request ? input.url : String(input), window.location.origin).pathname;
      if (path.endsWith("/setup-token")) {
        const { token } = JSON.parse(String(init?.body ?? "{}"));
        if (!String(token).startsWith("sk-ant-oat01-"))
          return Response.json({ error: "This is not a Claude setup-token. Run claude setup-token and paste the token that starts with sk-ant-oat01-." }, { status: 422 });
        return Response.json({ connectionId: "connection", grantId: "grant" });
      }
      return previous(input, init);
    };
    window.fetch = fixtureFetch;
    return () => { if (window.fetch === fixtureFetch) window.fetch = previous; };
  }, []);
  return <QueryClientProvider client={client}>
    <main className="mx-auto max-w-xl space-y-4 p-6">
      <h2 className="text-lg font-semibold">Reconnect account</h2>
      <p className="text-sm text-muted-foreground">Sign in again to repair your current default account. Its agent access stays the same.</p>
      <AiConnectionSetupTokenPaste companyId="company-storybook" connectionId="connection" onComplete={() => setSaved(true)} />
      {saved && <p role="status" className="text-sm">Saved. The account is connected again.</p>}
    </main>
  </QueryClientProvider>;
}

const meta = {
  title: "AI Connections/Paste a setup-token",
  component: SetupTokenPasteReview,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof SetupTokenPasteReview>;
export default meta;
type Story = StoryObj<typeof meta>;

export const WrongShape: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Paste a setup-token" }));
    await userEvent.type(await canvas.findByLabelText("Setup-token"), "not-a-token");
    await userEvent.click(canvas.getByRole("button", { name: "Save token" }));
    await expect(await canvas.findByRole("alert")).toHaveTextContent("not a Claude setup-token");
  },
};
