import { useLayoutEffect, useRef, type ComponentProps } from "react";

/** One Tab stop; arrows visit controls, including custom selects and text inputs. */
export function KeyboardToolbar({ children, ...props }: ComponentProps<"div">) {
  const ref = useRef<HTMLDivElement>(null);
  const controls = () =>
    [
      ...(ref.current?.querySelectorAll<HTMLElement>("button,input,select,[role=checkbox]") ?? []),
    ].filter(
      (element) =>
        element.closest('[role="toolbar"]') === ref.current &&
        !element.matches(
          ':disabled,[aria-disabled="true"],[aria-hidden="true"],[hidden],input[type="hidden"]',
        ),
    );
  const rove = (active?: HTMLElement) => {
    const items = controls();
    const current = active ?? items.find((item) => item.tabIndex === 0) ?? items[0];
    for (const item of items) item.tabIndex = item === current ? 0 : -1;
  };
  useLayoutEffect(() => {
    rove();
    const observer = new window.MutationObserver(() => rove());
    if (ref.current)
      observer.observe(ref.current, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["disabled", "aria-disabled"],
      });
    return () => observer.disconnect();
  });
  return (
    <div
      {...props}
      ref={ref}
      // A toolbar contains mixed controls; no native element provides its role.
      // oxlint-disable-next-line jsx-a11y/prefer-tag-over-role
      role="toolbar"
      onFocusCapture={(event) => {
        if (controls().includes(event.target)) rove(event.target);
      }}
      onKeyDownCapture={(event) => {
        if (
          event.altKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.shiftKey ||
          event.defaultPrevented
        )
          return;
        const target = event.target;
        if (!(target instanceof HTMLElement) || !ref.current?.contains(target)) return;
        if (
          target.closest('[role="listbox"],[role="menu"]') ||
          target.getAttribute("aria-expanded") === "true"
        )
          return;
        // Text editing retains Left/Right/Home/End. Up/Down moves to another control.
        const editing = target.matches("input,textarea");
        const next = event.key === "ArrowRight" || (editing && event.key === "ArrowDown");
        const previous = event.key === "ArrowLeft" || (editing && event.key === "ArrowUp");
        if (editing && !["ArrowUp", "ArrowDown"].includes(event.key)) return;
        if (!next && !previous && event.key !== "Home" && event.key !== "End") return;
        const items = controls();
        if (!items.length) return;
        const index = items.indexOf(target);
        const destination =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? items.length - 1
              : (index + (next ? 1 : -1) + items.length) % items.length;
        event.preventDefault();
        event.stopPropagation();
        items[destination]?.focus();
      }}
    >
      {children}
    </div>
  );
}
