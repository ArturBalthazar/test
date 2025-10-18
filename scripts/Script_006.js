class CustomLogic {
  static inspector = {
    colorChangeInterval: {
      type: "number",
      label: "Color Change Interval (seconds)",
      default: 10,
      min: 1
    }
  };

  async attach(self, ctx) {
    const p = this.params ?? {};
    
    // Debug logging
    console.log("🔧 Script attached to:", self?.name || "unknown object");
    console.log("🔧 Parameters received:", p);

    // Create a new material for the object
    const material = new BABYLON.StandardMaterial("customMaterial", ctx.scene);
    self.material = material;

    // Function to change the material's color
    const changeColor = () => {
      const newColor = new BABYLON.Color3(Math.random(), Math.random(), Math.random());
      material.diffuseColor = newColor;
      console.log("🎨 Material color changed to:", newColor.toHexString());
    };

    // Initial color change
    changeColor();

    // Setup interval for changing color
    this.colorInterval = setInterval(changeColor, p.colorChangeInterval * 1000);

    // Log the interval setup
    console.log("⏲️ Color change interval set to every", p.colorChangeInterval, "seconds");
  }

  detach() {
    if (this.colorInterval) {
      clearInterval(this.colorInterval);
      console.log("🧹 Interval cleared on detach");
    }
  }
}