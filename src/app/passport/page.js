import ToolLayout from "@/components/ToolLayout";
import PassportPhotoMaker from "@/components/PassportPhotoMaker";

export const metadata = {
  title: "Passport Image — PixShrink",
  description: "Create 3.5×4.5 cm Passport and 2.0×2.5 cm Stamp photo sheets with AI backgrounds.",
};

export default function PassportPage() {
  return (
    <ToolLayout toolId="passport">
      <PassportPhotoMaker />
    </ToolLayout>
  );
}
