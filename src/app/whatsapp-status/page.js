import ToolLayout from "@/components/ToolLayout";
import WhatsappStatusSplitter from "@/components/WhatsappStatusSplitter";

export const metadata = {
  title: "WhatsApp Status Splitter — PixShrink",
  description: "Optimize and split videos up to 15 minutes into sequential 30s Status clips.",
};

export default function WhatsappStatusPage() {
  return (
    <ToolLayout toolId="whatsapp-status">
      <WhatsappStatusSplitter />
    </ToolLayout>
  );
}
