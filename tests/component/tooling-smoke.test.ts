// @vitest-environment happy-dom

import { mount } from "@vue/test-utils";
import { defineComponent, h, ref } from "vue";
import { describe, expect, it } from "vitest";

describe("Vue component test harness", () => {
  it("mounts an isolated typed component and handles interaction", async () => {
    const Probe = defineComponent({
      setup() {
        const count = ref(0);
        return () =>
          h(
            "button",
            {
              type: "button",
              onClick: () => {
                count.value += 1;
              },
            },
            `count ${count.value}`,
          );
      },
    });

    const wrapper = mount(Probe);
    expect(wrapper.text()).toBe("count 0");
    await wrapper.get("button").trigger("click");
    expect(wrapper.text()).toBe("count 1");
    wrapper.unmount();
  });
});
