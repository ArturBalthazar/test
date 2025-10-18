class CustomLogic {
  static inspector = {
    carRoot: { type: "nodeRef", label: "Car Root Node" },

    // Exterior buttons
    buttonDoors:        { type: "uiElement", label: "Button • Doors" },
    buttonChargingPort: { type: "uiElement", label: "Button • Charging Port" },
    buttonTrunk:        { type: "uiElement", label: "Button • Trunk" },
    buttonNFC:          { type: "uiElement", label: "Button • NFC" },

    // Toggle + interior buttons
    buttonToggleInterior: { type: "uiElement", label: "Button • Toggle Interior/Exterior" },
    buttonSteeringWheel:  { type: "uiElement", label: "Button • Steering Wheel (Interior)" },
    buttonScreen:         { type: "uiElement", label: "Button • Screen (Interior)" },

    // Frame controls
    framesDoors:         { type: "number", label: "Frames • Doors", default: 0, min: 0, max: 1000, step: 1 },
    framesChargingPort:  { type: "number", label: "Frames • Charging Port", default: 0, min: 0, max: 1000, step: 1 },
    framesTrunk:         { type: "number", label: "Frames • Trunk", default: 0, min: 0, max: 1000, step: 1 },
    framesNFC:           { type: "number", label: "Frames • NFC", default: 0, min: 0, max: 1000, step: 1 },
    framesSteeringWheel: { type: "number", label: "Frames • Steering Wheel (Interior)", default: 0, min: 0, max: 1000, step: 1 },
    framesScreen:        { type: "number", label: "Frames • Screen (Interior)", default: 0, min: 0, max: 1000, step: 1 },

    // Global speed
    speedMultiplier:     { type: "number", label: "Global Speed Multiplier", default: 1, min: 0.1, max: 4, step: 0.1 },
  };

  async attach(self, ctx) {
    this._ctx = ctx;
    this._clickHandlers = [];
    this._guiObservers = [];
    this._timeouts = [];
    this._busy = false;

    this._state = {
      doorsOpen: false,
      chargingPortOpen: false,
      trunkOpen: false,
      nfcOpen: true,   // <-- start OPEN
      screenOpen: false,
      isInterior: false,
    };

    this._uiExterior = [];
    this._uiInterior = [];
    this._uiToggle = null;

    // Root
    this._carRoot = ctx.getByRef?.(this.params?.carRoot) || self;
    if (!this._carRoot) return;

    this._carNodeSet = this._collectHierarchyNodes(this._carRoot);
    this._allSceneGroups = ctx.scene?.animationGroups || [];
    this._sceneGroupsByName = new Map(this._allSceneGroups.map(g => [g.name, g]));
    this._carGroups = this._allSceneGroups.filter(g => this._groupTargetsCar(g, this._carNodeSet));
    this._groupsByName = new Map(this._carGroups.map(g => [g.name, g]));

    this._resetGroupsToStart(this._allSceneGroups);
    this._resetGroupsToStart(this._carGroups);

    this._timeouts.push(setTimeout(() => {
      this._resetGroupsToStart(this._allSceneGroups);
      this._resetGroupsToStart(this._carGroups);
      this._primeNFCOpen(); // <-- prime open
    }, 0));

    // Wire UI
    const doorsEl  = await this._wireButton(ctx, "buttonDoors", "Doors", () => this._onDoorsClick());
    const chargeEl = await this._wireButton(ctx, "buttonChargingPort", "Charging Port", () => this._onChargingPortClick());
    const trunkEl  = await this._wireButton(ctx, "buttonTrunk", "Trunk", () => this._onTrunkClick());
    const nfcEl    = await this._wireButton(ctx, "buttonNFC", "NFC", () => this._onNFCClick());
    [doorsEl, chargeEl, trunkEl, nfcEl].forEach(el => el && this._uiExterior.push(el));

    this._uiToggle = await this._wireButton(ctx, "buttonToggleInterior", "Toggle Interior/Exterior", () => this._onToggleInterior());
    const wheelEl  = await this._wireButton(ctx, "buttonSteeringWheel", "Steering Wheel", () => this._onSteeringWheelClick());
    const screenEl = await this._wireButton(ctx, "buttonScreen", "Screen", () => this._onScreenClick());
    [wheelEl, screenEl].forEach(el => el && this._uiInterior.push(el));

    this._applyUIMode(false);
  }

  detach() {
    this._clickHandlers.forEach(({ el, handler }) => { try { el?.removeEventListener?.("click", handler); } catch {} });
    this._guiObservers.forEach(({ control, observer }) => { try { control?.onPointerUpObservable?.remove?.(observer); } catch {} });
    this._timeouts.forEach(id => clearTimeout(id));
    this._clickHandlers = this._guiObservers = this._timeouts = [];
  }

  // -----------------------------
  // Helpers
  // -----------------------------

  _speed() {
    const s = Number(this.params?.speedMultiplier ?? 1);
    return isFinite(s) ? Math.max(0.0001, s) : 1;
  }

  _collectHierarchyNodes(root) {
    const set = new Set([root]);
    try { root.getDescendants(false).forEach(d => set.add(d)); } catch {}
    return set;
  }

  _groupTargetsCar(group, nodeSet) {
    return (group?.targetedAnimations || []).some(ta => {
      const t = ta?.target;
      return nodeSet.has(t) || nodeSet.has(t?.getTransformNode?.()) || nodeSet.has(t?._node) || nodeSet.has(t?.ownerNode);
    });
  }

  _forceApplyFrame(group, frame) {
    try {
      group.reset();
      group.start(false, 1, frame, frame);
      group.stop();
      group.goToFrame?.(frame);
      for (const ta of group.targetedAnimations || []) { ta.animation?.evaluate?.(frame); }
    } catch {}
  }

  _resetGroupsToStart(groups) {
    for (const g of groups || []) {
      const from = (typeof g.from === "number") ? g.from : 0;
      this._forceApplyFrame(g, from);
    }
  }

  async _wireButton(ctx, paramName, label, handler) {
    const ref = this.params?.[paramName];
    const el = await ctx.getUIElement?.(ref);
    if (!el) return null;
    if (typeof el.addEventListener === "function") {
      el.addEventListener("click", handler);
      this._clickHandlers.push({ el, handler });
    } else if (el.onPointerUpObservable?.add) {
      const observer = el.onPointerUpObservable.add(handler);
      this._guiObservers.push({ control: el, observer });
    }
    return el;
  }

  _normalizeName(n) { return String(n || "").trim().toLowerCase(); }
  _findGroupByNameFuzzy(name) {
    const norm = this._normalizeName(name);
    return (
      this._groupsByName.get(name) ||
      this._sceneGroupsByName.get(name) ||
      (this._carGroups||[]).find(g => this._normalizeName(g.name).includes(norm)) ||
      (this._allSceneGroups||[]).find(g => this._normalizeName(g.name).includes(norm))
    );
  }

  _playGroup(group, forward, frames) {
    if (!group) return;
    const from = (typeof group.from === "number") ? group.from : 0;
    const to   = (typeof group.to === "number") ? group.to : from;
    const rangeTo = frames > 0 ? Math.min(from + frames, to) : to;
    group.stop();
    group.goToFrame?.(forward ? from : rangeTo);
    group.start(false, this._speed() * (forward ? 1 : -1), from, rangeTo);
  }

  _waitEnd(group) {
    return new Promise(res => {
      const tick = () => { if (!group?.isPlaying) return res(); this._timeouts.push(setTimeout(tick, 20)); };
      tick();
    });
  }

  _setElementVisible(el, visible) {
    if (!el) return;
    if (el.style) {
      el.style.display = visible ? "" : "none";
      el.style.pointerEvents = visible ? "" : "none";
    }
    if ("isVisible" in el) el.isVisible = visible;
    if ("isEnabled" in el) el.isEnabled = visible;
    if ("isHitTestVisible" in el) el.isHitTestVisible = visible;
  }

  _applyUIMode(isInterior) {
    this._state.isInterior = !!isInterior;
    this._uiExterior.forEach(el => this._setElementVisible(el, !isInterior));
    this._uiInterior.forEach(el => this._setElementVisible(el,  isInterior));
    if (this._uiToggle) this._setElementVisible(this._uiToggle, true);
  }

  // -----------------------------
  // NFC setup & handler
  // -----------------------------

  _primeNFCOpen() {
    const openG  = this._findGroupByNameFuzzy("mk_animation_ID18_NFC_Open");
    const closeG = this._findGroupByNameFuzzy("mk_animation_ID18_NFC_Close");
    if (openG) {
      const openTo = (typeof openG.to === "number") ? openG.to : (openG.from || 0);
      this._forceApplyFrame(openG, openTo);
    } else if (closeG) {
      this._forceApplyFrame(closeG, closeG.from || 0);
    }
    this._state.nfcOpen = true;
  }

  async _onNFCClick() {
    const openG  = this._findGroupByNameFuzzy("mk_animation_ID18_NFC_Open");
    const closeG = this._findGroupByNameFuzzy("mk_animation_ID18_NFC_Close");
    const frames = Number(this.params?.framesNFC ?? 0);

    if (!openG && !closeG) return;

    if (this._state.nfcOpen) {
      // open → close
      if (closeG) {
        this._forceApplyFrame(closeG, closeG.from || 0);
        this._playGroup(closeG, true, frames);
        await this._waitEnd(closeG);
        this._state.nfcOpen = false;
      }
    } else {
      // closed → open
      if (openG) {
        this._forceApplyFrame(openG, openG.from || 0);
        this._playGroup(openG, true, frames);
        await this._waitEnd(openG);
        this._state.nfcOpen = true;
      }
    }
  }

  // -----------------------------
  // Button handlers
  // -----------------------------

  async _onToggleInterior() { this._applyUIMode(!this._state.isInterior); }

  async _onDoorsClick() {
    const names = ["mk_animation_ID0_BL","mk_animation_ID0_BR","mk_animation_ID0_FL","mk_animation_ID0_FR"];
    const groups = names.map(n=>this._findGroupByNameFuzzy(n)).filter(Boolean);
    if (!groups.length) return;
    const forward = !this._state.doorsOpen;
    groups.forEach(g => this._playGroup(g, forward, this.params?.framesDoors||0));
    await Promise.all(groups.map(g=>this._waitEnd(g)));
    this._state.doorsOpen = forward;
  }

  async _onChargingPortClick() {
    const g = this._findGroupByNameFuzzy("mk_animation_ID10_ChargingPort");
    if (!g) return;
    const forward = !this._state.chargingPortOpen;
    this._playGroup(g, forward, this.params?.framesChargingPort||0);
    await this._waitEnd(g);
    this._state.chargingPortOpen = forward;
  }

  async _onTrunkClick() {
    const g = this._findGroupByNameFuzzy("mk_animation_ID6_Trunk_Open");
    if (!g) return;
    const forward = !this._state.trunkOpen;
    this._playGroup(g, forward, this.params?.framesTrunk||0);
    await this._waitEnd(g);
    this._state.trunkOpen = forward;
  }

  async _onSteeringWheelClick() {
    const g = this._findGroupByNameFuzzy("mk_animation_ID8_Wheel");
    if (!g) return;
    this._forceApplyFrame(g, g.from||0);
    this._playGroup(g, true, this.params?.framesSteeringWheel||0);
    await this._waitEnd(g);
  }

  async _onScreenClick() {
    const g = this._findGroupByNameFuzzy("mk_animation_ID7_Screen");
    if (!g) return;
    const forward = !this._state.screenOpen;
    this._playGroup(g, forward, this.params?.framesScreen||0);
    await this._waitEnd(g);
    this._state.screenOpen = forward;
  }
}
