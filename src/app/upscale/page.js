import ToolLayout from "@/components/ToolLayout";
import ImageUpscaler from "@/components/ImageUpscaler";

export const metadata = {
  title: "Image Upscale — PixShrink",
  description: "2× and 4× detail-reviving super-resolution in your browser.",
};

export default function UpscalePage() {
  return (
    <ToolLayout toolId="upscale">
      <ImageUpscaler />
    </ToolLayout>
  );
}
