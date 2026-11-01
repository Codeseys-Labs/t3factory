import { createFileRoute } from "@tanstack/react-router";

import { FactoryWorkPage } from "../components/factory/FactoryWorkPage";

export const Route = createFileRoute("/_chat/factory/")({
  component: FactoryWorkPage,
});
