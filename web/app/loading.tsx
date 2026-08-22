import { Spinner } from "@heroui/react";

export default function Loading() {
  return (
    <div className="grid min-h-dvh place-items-center">
      <Spinner aria-label="Loading" size="lg" />
    </div>
  );
}
