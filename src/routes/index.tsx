import { createFileRoute } from "@tanstack/react-router";
import RaceGame3D from "@/components/RaceGame3D";

export const Route = createFileRoute("/")({
  component: Index,
});

function Index() {
  return <RaceGame3D />;
}
