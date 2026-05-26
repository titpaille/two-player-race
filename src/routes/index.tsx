import { createFileRoute } from "@tanstack/react-router";
import RaceGame from "@/components/RaceGame";

export const Route = createFileRoute("/")({
  component: Index,
});

function Index() {
  return <RaceGame />;
}
