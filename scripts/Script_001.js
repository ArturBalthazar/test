class CustomLogic {
  static inspector = {
    // UI Buttons - Exterior Colors
    colorYellowBtn: { type: "uiElement", label: "Color: Yellow" },
    colorWhiteBtn: { type: "uiElement", label: "Color: White" },
    colorBlackBtn: { type: "uiElement", label: "Color: Black" },
    colorPinkBtn: { type: "uiElement", label: "Color: Pink" },

    // UI Buttons - Interior Trims
    trimLightBlueBtn: { type: "uiElement", label: "Trim: Light Blue" },
    trimPinkBtn: { type: "uiElement", label: "Trim: Pink" },
    trimDarkBlueBtn: { type: "uiElement", label: "Trim: Dark Blue" },

    // UI Button - View swap
    viewSwapBtn: { type: "uiElement", label: "Swap View (Ext/Int)" },

    // Node refs - Cameras
    exteriorCameraRef: { type: "nodeRef", label: "Exterior Camera" },
    interiorCameraRef: { type: "nodeRef", label: "Interior Camera" },

    // Node ref - Car root/object to rotate
    carRef: { type: "nodeRef", label: "Car Root Node" },

    // Rotation strength
    rotationStrength: {
      type: "number",
      label: "Car Rotation Strength",
      min: 0,
      max: 0.2,
      step: 0.001,
      default: 0.01
    }
  };

  async attach(self, ctx) {
    const p = this.params ?? {};
    console.log("🔧 Script attached to:", self?.name || "unknown object");
    console.log("🔧 Parameters received:", p);

    // Store context, canvas and scene
    this._ctx = ctx;
    this._scene = ctx.scene;
    this._engine = ctx.engine;
    this._canvas = ctx.engine?.getRenderingCanvas?.() || ctx.canvas || null;

    // Define color and trim configurations
    this._colorSettings = {
      yellow:  { hex: "#AFBF25", metallic: 0.2, roughness: 0.2, sheen: 1 },
      white:   { hex: "#E5DDC9", metallic: 0.2, roughness: 0.2, sheen: 1 },
      black:   { hex: "#000000", metallic: 0.7, roughness: 0.2, sheen: 0.2 },
      pink:    { hex: "#E8BDE1", metallic: 0.18, roughness: 0.2, sheen: 1 }
    };

    this._trimConfigs = {
      lightBlue: {
        allowed: ["yellow"],
        materials: {
          byd_leather_02: "byd_leather_black_02",
          byd_leather_03: "byd_leather_black_03",
          byd_leather_04: "byd_leather_perforated_blue",
          byd_leather_05: "byd_leather_light_blue_05",
          byd_leather_06: "byd_leather_light_blue_06",
          byd_metallic_plastic_01: "byd_metal_paint",
          byd_metallic_plastic_02: "byd_metallic_blue",
          byd_metallic_plastic_03: "byd_yellow",
          byd_steering_wheel: "byd_plastic_skin_wheel",
          byd_buttons: "byd_atlas_metallic",
          byd_stitches: "byd_stitches_yellow"
        }
      },
      pink: {
        allowed: ["white", "pink"],
        materials: {
          byd_leather_02: "byd_leather_black_02",
          byd_leather_03: "byd_leather_pink_03",
          byd_leather_04: "byd_leather_black_04",
          byd_leather_05: "byd_leather_pink_05",
          byd_leather_06: "byd_leather_pink_06",
          byd_metallic_plastic_01: "byd_metal_paint",
          byd_metallic_plastic_02: "byd_metallic_pink",
          byd_metallic_plastic_03: "byd_pink",
          byd_steering_wheel: "byd_plastic_skin_wheel",
          byd_buttons: "byd_atlas_metallic",
          byd_stitches: "byd_stitches_pink"
        }
      },
      darkBlue: {
        allowed: ["white", "black"],
        materials: {
          byd_leather_02: "byd_leather_perforated_dark_blue",
          byd_leather_03: "byd_leather_black_03",
          byd_leather_04: "byd_leather_perforated_red",
          byd_leather_05: "byd_leather_dark_blue",
          byd_leather_06: "byd_leather_black_06",
          byd_metallic_plastic_01: "byd_black_piano",
          byd_metallic_plastic_02: "byd_metallic_black",
          byd_metallic_plastic_03: "byd_orange",
          byd_steering_wheel: "byd_leather_dark_blue_wheel",
          byd_buttons: "byd_atlas_dark",
          byd_stitches: "byd_stitches_orange"
        }
      }
    };

    // Internal state
    this._mode = "exterior"; // "exterior" or "interior"
    this._currentColor = "yellow"; // default color
    this._currentTrim = "lightBlue"; // default trim aligned with yellow
    this._ui = {}; // cache UI controls
    this._uiHandlers = []; // for cleanup
    this._buttonDisabled = new WeakMap(); // UI enabled map
    this._pointerObserver = null;
    this._isDragging = false;
    this._lastX = 0;

    // Resolve references
    this._extCam = ctx.getByRef?.(p.exteriorCameraRef) || null;
    this._intCam = ctx.getByRef?.(p.interiorCameraRef) || null;
    this._car = ctx.getByRef?.(p.carRef) || self || null;

    if (!this._extCam || !this._intCam) {
      console.log("⚠️ Cameras not fully assigned. exteriorCameraRef:", !!this._extCam, "interiorCameraRef:", !!this._intCam);
    } else {
      console.log("✅ Cameras resolved:", this._extCam.name, this._intCam.name);
    }

    if (!this._car) {
      console.log("⚠️ Car node not found. Rotation will be disabled.");
    } else {
      console.log("✅ Car node resolved:", this._car.name);
    }

    // Resolve UI elements
    this._ui.colorYellowBtn = await ctx.getUIElement?.(p.colorYellowBtn);
    this._ui.colorWhiteBtn  = await ctx.getUIElement?.(p.colorWhiteBtn);
    this._ui.colorBlackBtn  = await ctx.getUIElement?.(p.colorBlackBtn);
    this._ui.colorPinkBtn   = await ctx.getUIElement?.(p.colorPinkBtn);

    this._ui.trimLightBlueBtn = await ctx.getUIElement?.(p.trimLightBlueBtn);
    this._ui.trimPinkBtn      = await ctx.getUIElement?.(p.trimPinkBtn);
    this._ui.trimDarkBlueBtn  = await ctx.getUIElement?.(p.trimDarkBlueBtn);

    this._ui.viewSwapBtn = await ctx.getUIElement?.(p.viewSwapBtn);

    // Hook UI listeners
    this._bindUI();

    // Prepare cameras: exterior active, no user control; interior inactive, free control when active
    this._applyCameraMode(true); // start exterior
    console.log("🎯 Initial mode: Exterior active (no user camera control).");

    // Apply initial material settings
    this._applyBodyColor(this._currentColor);
    this._applyTrim(this._currentTrim);

    // Initialize UI states based on mode and selections
    this._refreshButtonStates();

    // Pointer drag handling for car rotation (exterior only)
    this._installPointerDrag();
    
    // Asign AO maps
    this._assignAOMaps();

    console.log("✅ Setup complete.");
  }

  // --------------------- Helper Methods ---------------------

  _assignAOMaps() {
    console.log("🔍 Assigning AO maps to the correct slots...");
    this._scene.meshes.forEach(mesh => {
      if (!(mesh instanceof BABYLON.Mesh)) return;
      
      const material = mesh.material;
      if (material && material.ambientTexture) {
        // Ensure the AO map is assigned to the ambient texture slot
        material.ambientTexture.coordinatesIndex = 1;
        console.log(`✅ AO map assigned for mesh: ${mesh.name}, material: ${material.name}`);
      } else {
        console.log(`⚠️ No ambient texture found for mesh: ${mesh.name}`);
      }
    });
  }


  _bindUI() {
    // Helper to attach click handlers to GUI or DOM elements
    const addClick = (ctrl, fn) => {
      if (!ctrl) return;
      // Mark enabled by default
      this._setButtonEnabled(ctrl, true);

      // Babylon GUI Control
      if (ctrl.onPointerClickObservable) {
        const obs = ctrl.onPointerClickObservable.add((evt) => {
          if (this._isButtonDisabled(ctrl)) {
            console.log("⚠️ Click ignored on disabled control.");
            return;
          }
          fn(evt);
        });
        this._uiHandlers.push(() => ctrl.onPointerClickObservable.remove(obs));
      }
      // Babylon GUI pointer up fallback
      else if (ctrl.onPointerUpObservable) {
        const obs = ctrl.onPointerUpObservable.add((evt) => {
          if (this._isButtonDisabled(ctrl)) {
            console.log("⚠️ Click ignored on disabled control.");
            return;
          }
          fn(evt);
        });
        this._uiHandlers.push(() => ctrl.onPointerUpObservable.remove(obs));
      }
      // DOM element
      else if (ctrl.addEventListener) {
        const handler = (e) => {
          if (this._isButtonDisabled(ctrl)) {
            console.log("⚠️ Click ignored on disabled control.");
            return;
          }
          fn(e);
        };
        ctrl.addEventListener("click", handler);
        this._uiHandlers.push(() => ctrl.removeEventListener("click", handler));
      } else {
        console.log("❌ Unknown UI element type. Could not bind click.", ctrl);
      }
    };

    // Exterior color clicks
    addClick(this._ui.colorYellowBtn, () => this._onColorClicked("yellow"));
    addClick(this._ui.colorWhiteBtn,  () => this._onColorClicked("white"));
    addClick(this._ui.colorBlackBtn,  () => this._onColorClicked("black"));
    addClick(this._ui.colorPinkBtn,   () => this._onColorClicked("pink"));

    // Trim clicks
    addClick(this._ui.trimLightBlueBtn, () => this._onTrimClicked("lightBlue"));
    addClick(this._ui.trimPinkBtn,      () => this._onTrimClicked("pink"));
    addClick(this._ui.trimDarkBlueBtn,  () => this._onTrimClicked("darkBlue"));

    // View swap
    addClick(this._ui.viewSwapBtn, () => this._toggleViewMode());
  }

  _isButtonDisabled(btn) {
    return this._buttonDisabled?.get(btn) === true;
  }

  _setButtonEnabled(btn, enabled) {
    if (!btn) return;
    const dimAlpha = 0.35;
    const fullAlpha = 1;

    // Babylon GUI Control
    if (typeof btn.alpha === "number") {
      btn.alpha = enabled ? fullAlpha : dimAlpha;
      if ("isEnabled" in btn) btn.isEnabled = enabled;
      if ("isHitTestVisible" in btn) btn.isHitTestVisible = enabled;
    }
    // DOM element
    if (btn.style) {
      btn.style.opacity = enabled ? "1" : "0.35";
      btn.style.pointerEvents = enabled ? "auto" : "none";
      btn.style.filter = enabled ? "" : "grayscale(0.3)";
    }
    this._buttonDisabled.set(btn, !enabled);
  }

  _refreshButtonStates() {
    // Based on mode and current selections, enable/disable UI buttons
    const allColors = ["yellow", "white", "black", "pink"];
    const allTrims = ["lightBlue", "pink", "darkBlue"];

    // Map color/trims to UI refs
    const colorToUI = {
      yellow: this._ui.colorYellowBtn,
      white: this._ui.colorWhiteBtn,
      black: this._ui.colorBlackBtn,
      pink: this._ui.colorPinkBtn
    };
    const trimToUI = {
      lightBlue: this._ui.trimLightBlueBtn,
      pink: this._ui.trimPinkBtn,
      darkBlue: this._ui.trimDarkBlueBtn
    };

    if (this._mode === "exterior") {
      // Exterior mode: you can set any exterior color; trims must follow color
      // Enable all colors
      allColors.forEach(c => this._setButtonEnabled(colorToUI[c], true));

      // Compute allowed trims for current color (trims whose allowed includes color)
      const allowedTrims = allTrims.filter(t => this._trimConfigs[t].allowed.includes(this._currentColor));
      allTrims.forEach(t => this._setButtonEnabled(trimToUI[t], allowedTrims.includes(t)));

    } else {
      // Interior mode: you can set any trim; colors must follow trim
      // Enable all trims
      allTrims.forEach(t => this._setButtonEnabled(trimToUI[t], true));

      // Only enable colors allowed by current trim
      const allowedColors = this._trimConfigs[this._currentTrim].allowed;
      allColors.forEach(c => this._setButtonEnabled(colorToUI[c], allowedColors.includes(c)));
    }

    console.log(`🎛️ UI states refreshed. Mode=${this._mode}, Color=${this._currentColor}, Trim=${this._currentTrim}`);
  }

  _onColorClicked(colorKey) {
    console.log("🖌️ Color button clicked:", colorKey, "Mode:", this._mode);
    if (this._mode === "interior") {
      // Interior mode: color constrained by current trim
      const allowed = this._trimConfigs[this._currentTrim].allowed;
      if (!allowed.includes(colorKey)) {
        console.log("⚠️ Color not allowed by current trim in interior mode. Ignored.");
        return;
      }
    }
    // Exterior mode or allowed in interior -> apply color
    this._currentColor = colorKey;
    this._applyBodyColor(colorKey);

    if (this._mode === "exterior") {
      // Ensure trim follows color constraints; auto-pick if current trim becomes invalid
      const validTrims = Object.keys(this._trimConfigs).filter(t => this._trimConfigs[t].allowed.includes(colorKey));
      if (!validTrims.includes(this._currentTrim)) {
        const nextTrim = validTrims[0];
        if (nextTrim) {
          console.log("🔄 Auto-switching trim to match color:", nextTrim);
          this._currentTrim = nextTrim;
          this._applyTrim(nextTrim);
        } else {
          console.log("❌ No valid trims found for selected color. Trim unchanged.");
        }
      }
    }

    this._refreshButtonStates();
  }

  _onTrimClicked(trimKey) {
    console.log("🧵 Trim button clicked:", trimKey, "Mode:", this._mode);
    if (this._mode === "exterior") {
      // Exterior mode: trim constrained by color
      const allowed = this._trimConfigs[trimKey].allowed;
      if (!allowed.includes(this._currentColor)) {
        console.log("⚠️ Trim not allowed for current color in exterior mode. Ignored.");
        return;
      }
    }
    // Interior mode or allowed in exterior -> apply trim
    this._currentTrim = trimKey;
    this._applyTrim(trimKey);

    // In interior mode, color options adjust (dim) but color stays until user changes it
    this._refreshButtonStates();
  }

  _toggleViewMode() {
    const toExterior = this._mode !== "exterior";
    this._applyCameraMode(toExterior);
    this._refreshButtonStates();
  }

  _applyCameraMode(exterior) {
    this._mode = exterior ? "exterior" : "interior";
    const scene = this._scene;
    const canvas = this._canvas;

    if (this._extCam && this._intCam) {
      // Set active camera and attach/detach controls
      if (exterior) {
        scene.activeCamera = this._extCam;
        // External camera has no user control
        try { this._extCam.detachControl?.(canvas); } catch (e) {}
        // Interior camera: ensure detached while inactive
        try { this._intCam.detachControl?.(canvas); } catch (e) {}
        console.log("🎥 Switched to EXTERIOR camera:", this._extCam.name, "(controls disabled)");
      } else {
        scene.activeCamera = this._intCam;
        // Interior camera should have free rotation
        try { this._intCam.attachControl?.(canvas, true); } catch (e) {}
        // External camera: ensure detached while inactive
        try { this._extCam.detachControl?.(canvas); } catch (e) {}
        console.log("🎥 Switched to INTERIOR camera:", this._intCam.name, "(controls enabled)");
      }
    } else {
      console.log("⚠️ One or both cameras missing. Cannot swap properly.");
    }
  }

  _applyBodyColor(colorKey) {
    const cfg = this._colorSettings[colorKey];
    if (!cfg) {
      console.log("❌ Unknown color key:", colorKey);
      return;
    }

    const scene = this._scene;
    const BABYLONNS = (typeof BABYLON !== "undefined") ? BABYLON : window.BABYLON;
    const color3 = BABYLONNS?.Color3?.FromHexString ? BABYLONNS.Color3.FromHexString(cfg.hex) : null;

    // Find the material named "Body_Paint"
    const mat = scene.materials?.find(m => m.name === "Body_Paint");
    if (!mat) {
      console.log("❌ Material 'Body_Paint' not found in scene.");
      return;
    }

    try {
      // PBRMaterial or PBRMetallicRoughness support
      if ("albedoColor" in mat && color3) mat.albedoColor = color3;
      if ("baseColor" in mat && color3) mat.baseColor = color3;

      if ("metallic" in mat) mat.metallic = cfg.metallic;
      if ("roughness" in mat) mat.roughness = cfg.roughness;

      // Sheen controls (if available)
      if (mat.sheen) {
        mat.sheen.isEnabled = true;
        if ("intensity" in mat.sheen) mat.sheen.intensity = cfg.sheen;
        if (color3 && "color" in mat.sheen) mat.sheen.color = color3.scale(0.9);
      }

      console.log(`✅ Body color applied -> ${colorKey} (${cfg.hex}), metallic=${cfg.metallic}, roughness=${cfg.roughness}, sheen=${cfg.sheen}`);
      this._currentColor = colorKey;
    } catch (e) {
      console.log("❌ Failed to apply body color:", e);
    }
  }

  _applyTrim(trimKey) {
    const cfg = this._trimConfigs[trimKey];
    if (!cfg) {
      console.log("❌ Unknown trim key:", trimKey);
      return;
    }

    const scene = this._scene;
    let changed = 0, missingMeshes = 0, missingMats = 0;

    Object.entries(cfg.materials).forEach(([meshName, matName]) => {
      const mesh = scene.getMeshByName?.(meshName);
      if (!mesh) {
        missingMeshes++;
        console.log("⚠️ Mesh not found for trim mapping:", meshName);
        return;
      }
      const mat = scene.materials?.find(m => m.name === matName);
      if (!mat) {
        missingMats++;
        console.log("⚠️ Material not found for trim mapping:", matName, "for mesh:", meshName);
        return;
      }
      try {
        mesh.material = mat;
        changed++;
      } catch (e) {
        console.log("❌ Failed to assign material:", matName, "to mesh:", meshName, e);
      }
    });

    console.log(`✅ Trim applied -> ${trimKey}. Updated ${changed} meshes. Missing meshes: ${missingMeshes}, missing mats: ${missingMats}`);
    this._currentTrim = trimKey;
  }

  _installPointerDrag() {
    const scene = this._scene;
    if (!scene) return;

    // Remove any existing observer
    if (this._pointerObserver) {
      scene.onPointerObservable.remove(this._pointerObserver);
      this._pointerObserver = null;
    }

    const BABYLONNS = (typeof BABYLON !== "undefined") ? BABYLON : window.BABYLON;
    const PointerInfo = BABYLONNS?.PointerEventTypes || { POINTERDOWN: 1, POINTERUP: 2, POINTERMOVE: 4 };

    this._pointerObserver = scene.onPointerObservable.add((pi) => {
      if (!this._car) return;

      const type = pi.type;
      if (type === PointerInfo.POINTERDOWN) {
        this._isDragging = true;
        this._lastX = pi.event?.clientX ?? 0;
      } else if (type === PointerInfo.POINTERUP) {
        this._isDragging = false;
      } else if (type === PointerInfo.POINTERMOVE) {
        if (!this._isDragging) return;
        if (this._mode !== "exterior") return; // Only rotate in exterior mode

        const x = pi.event?.clientX ?? 0;
        const dx = x - this._lastX;
        this._lastX = x;

        // Rotate car around Y based on horizontal drag only
        const strength = Math.max(0, this.params?.rotationStrength ?? 0.01);
        try {
          this._car.rotation = this._car.rotation || { x: 0, y: 0, z: 0 };
          this._car.rotation.y += dx * strength;
        } catch (e) {
          // If rotation is not directly settable (e.g., TransformNode), try addRotation
          try {
            this._car.addRotation?.(0, dx * strength, 0);
          } catch (e2) {
            // Give up
          }
        }
      }
    });

    console.log("🧭 Pointer drag rotation installed (active only in exterior mode).");
  }

  // --------------------- Cleanup ---------------------

  detach() {
    // Remove UI handlers
    if (this._uiHandlers?.length) {
      this._uiHandlers.forEach(off => {
        try { off(); } catch (e) {}
      });
      this._uiHandlers = [];
    }

    // Remove pointer observers
    if (this._pointerObserver && this._scene?.onPointerObservable) {
      try { this._scene.onPointerObservable.remove(this._pointerObserver); } catch (e) {}
      this._pointerObserver = null;
    }

    // Detach camera controls to leave scene clean
    const canvas = this._canvas;
    try { this._extCam?.detachControl?.(canvas); } catch (e) {}
    try { this._intCam?.detachControl?.(canvas); } catch (e) {}

    console.log("🧹 Cleanup complete. Listeners and controls detached.");
  }
}
