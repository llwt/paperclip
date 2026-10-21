import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, userEvent, within } from "storybook/test";
import { AiConnectionRepairReview } from "../prototypes/AiConnectionRepairReview";

const meta = {
  title: "AI Connections/Repair a needs-reconnect mark",
  component: AiConnectionRepairReview,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof AiConnectionRepairReview>;
export default meta;
type Story = StoryObj<typeof meta>;

export const NeedsReconnect: Story = { args: { checkResult: "passed" } };

export const CheckAgainPasses: Story = {
  args: { checkResult: "passed" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Check again" }));
    await expect(await canvas.findByText("Personal default")).toBeInTheDocument();
  },
};

export const CheckAgainFails: Story = {
  args: { checkResult: "failed" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(await canvas.findByRole("button", { name: "Check again" }));
    await expect(await canvas.findByText(/The provider rejected this credential/)).toBeInTheDocument();
  },
};
