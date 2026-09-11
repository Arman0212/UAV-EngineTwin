import { InteractiveHoverButton } from "@/components/ui/interactive-hover-button";

function InteractiveHoverButtonDemo() {
  return (
    <div className="fixed top-5 right-7 z-50">
      <InteractiveHoverButton text="CONSOLE" onClick={() => (window as any).enterApp?.()} />
    </div>
  );
}

export { InteractiveHoverButtonDemo };
