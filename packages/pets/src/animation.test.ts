import { describe, expect, it } from "vite-plus/test";

import { AnimationController, DEFAULT_CELEBRATION_COOLDOWN_MS } from "./animation.ts";

const now = () => 10_000;

describe("AnimationController", () => {
  it("advances frames by the state's fps", () => {
    const controller = new AnimationController();
    controller.setDesiredState("running"); // fps 10 -> 100ms/frame
    controller.update(100);
    expect(controller.frame).toBe(1);
    controller.update(100);
    expect(controller.frame).toBe(2);
  });

  it("loops looping animations", () => {
    const controller = new AnimationController();
    controller.setDesiredState("idle"); // 6 frames, fps 10
    for (let i = 0; i < 6; i += 1) {
      controller.update(100);
    }
    expect(controller.frame).toBe(0);
  });

  it("ignores same-state requests (debounce)", () => {
    const controller = new AnimationController();
    controller.setDesiredState("running");
    controller.update(100);
    const frameAfterAdvance = controller.frame;
    controller.setDesiredState("running");
    expect(controller.frame).toBe(frameAfterAdvance);
    expect(controller.state).toBe("running");
  });

  it("plays a one-shot once and holds its final frame", () => {
    const completed: string[] = [];
    const controller = new AnimationController({
      onAnimationComplete: (state) => completed.push(state),
    });
    controller.setDesiredState("jumping"); // 5 frames, fps 12
    for (let i = 0; i < 10; i += 1) {
      controller.update(100);
    }
    expect(completed).toEqual(["jumping"]);
    expect(controller.frame).toBe(4);
    // Further updates stay clamped on the final frame.
    controller.update(100);
    expect(controller.frame).toBe(4);
    expect(completed).toEqual(["jumping"]);
  });

  it("celebrates completion with jumping before review (transient)", () => {
    const controller = new AnimationController();
    controller.setDesiredState("review", { celebrate: true, now: now() });
    expect(controller.state).toBe("jumping");
    for (let i = 0; i < 10; i += 1) {
      controller.update(100);
    }
    expect(controller.state).toBe("review");
  });

  it("respects the celebration cooldown (spec §97)", () => {
    const controller = new AnimationController();
    controller.setDesiredState("review", { celebrate: true, now: now() });
    expect(controller.state).toBe("jumping");
    for (let i = 0; i < 10; i += 1) {
      controller.update(100);
    }
    expect(controller.state).toBe("review");

    // Within the cooldown: no celebration, straight to the state.
    controller.setDesiredState("idle");
    controller.setDesiredState("review", {
      celebrate: true,
      now: now() + DEFAULT_CELEBRATION_COOLDOWN_MS - 1,
    });
    expect(controller.state).toBe("review");

    // After the cooldown: celebration again.
    controller.setDesiredState("idle");
    controller.setDesiredState("review", {
      celebrate: true,
      now: now() + DEFAULT_CELEBRATION_COOLDOWN_MS + 1,
    });
    expect(controller.state).toBe("jumping");
  });

  it("never celebrates into blocking states", () => {
    const controller = new AnimationController();
    controller.setDesiredState("waiting", { celebrate: true, now: now() });
    expect(controller.state).toBe("waiting");
    controller.setDesiredState("failed", { celebrate: true, now: now() });
    expect(controller.state).toBe("failed");
  });

  it("interrupts an in-flight celebration when the state changes", () => {
    const controller = new AnimationController();
    controller.setDesiredState("review", { celebrate: true, now: now() });
    expect(controller.state).toBe("jumping");
    controller.setDesiredState("failed");
    expect(controller.state).toBe("failed");
  });

  it("does not celebrate without an explicit clock", () => {
    const controller = new AnimationController();
    controller.setDesiredState("review", { celebrate: true });
    expect(controller.state).toBe("review");
  });

  it("reset forces a state regardless of transitions", () => {
    const controller = new AnimationController();
    controller.setDesiredState("running");
    controller.reset("idle");
    expect(controller.state).toBe("idle");
    expect(controller.frame).toBe(0);
  });

  it("ignores non-positive deltas", () => {
    const controller = new AnimationController();
    controller.setDesiredState("running");
    controller.update(0);
    controller.update(-100);
    expect(controller.frame).toBe(0);
  });
});
