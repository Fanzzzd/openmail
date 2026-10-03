import { afterEach, expect, it } from "vitest";
import { fireEvent, screen } from "@testing-library/react/pure";
import { flow, incoming, row, eventually } from "./harness";
let current: Awaited<ReturnType<typeof flow>> | undefined;
afterEach(async () => {
  await current?.dispose();
  current = undefined;
});

it("event detection uses core results and refreshes same-id body changes without stale confirmation", async () => {
  const reservation = (name: string) =>
    incoming("one", {
      bodyText: "",
      bodyHtml: `<script type="application/ld+json">{"@type":"FlightReservation","reservationFor":{"@type":"Flight","flightNumber":"${name}","departureTime":"2026-10-03T09:00:00Z"}}</script>`,
    });
  current = await flow({ messages: [reservation("AB123")] });
  const h = current;
  await eventually(() => expect(row(h.id("one"))).toBeTruthy());
  fireEvent.click(row(h.id("one")));
  await eventually(() => expect(screen.getByText("AB123")).toBeTruthy());
  expect(
    screen.getByText("End time is estimated. Review it before adding the event."),
  ).toBeTruthy();
  expect(h.requests.some((request) => request.tag === "DetectedEvents")).toBe(true);
  h.server.messages.set("one", reservation("CD456"));
  await h.run(h.m.sync());
  await eventually(() => expect(screen.getByText("CD456")).toBeTruthy());
  expect(screen.queryByText("AB123")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Add to calendar" }));
  await eventually(() =>
    expect(screen.getByRole("dialog", { name: "Add this event to your calendar?" })).toBeTruthy(),
  );
  fireEvent.click(screen.getByRole("button", { name: "Confirm and add event" }));
  await eventually(() => expect(h.server.createdEvents[0]?.title).toBe("CD456"));
  expect(h.server.createdEvents[0]?.endEstimated).toBe(true);
});
