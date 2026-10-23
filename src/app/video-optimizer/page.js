import ToolLayout from "@/components/ToolLayout";
import VideoOptimizer from "@/components/VideoOptimizer";

export const metadata = {
  title: "Video Optimizer — PixShrink",
  description: "Compress and scale videos for Web, 4K, 2K, YouTube, Instagram & WhatsApp.",
};

export default function VideoOptimizerPage() {
  return (
    <ToolLayout toolId="video-optimizer">
      <VideoOptimizer />
    </ToolLayout>
  );
}
