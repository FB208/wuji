Component({
  properties: {
    text: { type: String, value: "" },
    color: { type: String, value: "yellow" }, // yellow | blue | green | pink | white
    size: { type: String, value: "normal" }, // normal | large
    disabled: { type: Boolean, value: false },
  },
  methods: {
    onTap() {
      if (this.data.disabled) return;
      this.triggerEvent("tap");
    },
  },
});
