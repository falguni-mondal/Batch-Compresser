import ToolLayout from "@/components/ToolLayout";
import BgRemover from "@/components/BgRemover";

export const metadata = {
  title: "BG Remover — PixShrink",
  description: "Offline AI background removal and studio chroma key in your browser.",
};

export default function BgRemoverPage() {
  return (
    <ToolLayout toolId="bgremove">
      <BgRemover />
    </ToolLayout>
  );
}
