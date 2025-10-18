
// Dream Builder Runtime - Self-contained scene renderer
(async function() {
  const canvas = document.getElementById('renderCanvas');
  if (!canvas) {
    console.error('Canvas element not found');
    return;
  }

  // Make scene graph available to helper functions outside the try block scope
  let EXPORTED_SCENE_GRAPH = null;
  
  // Physics system variables
  let ammoWorld = null;
  let physicsPlugin = null;
  
  // Input control system variables
  let inputControlManager = null;
  
  // Camera tracking system variables
  let cameraTrackingManager = null;
  
  // Camera collision system variables
  let cameraCollisionManager = null;
  
  // Audio system variables
  let audioNodes = []; // Store audio objects for initialization
  let audioInitialized = false;
  let activeController = null; // Track active controller for spatial audio
  
  // Spatial UI system variables
  let spatialUIContainer = null; // DOM container for spatial UI elements
  let updateSpatialUI = null; // Function to update spatial UI (defined after scene loads)
  
  // Custom Logic system variables
  let customLogicManager = null;
  
  // Performance monitoring
  let fpsCounter = null;
  let lastFpsUpdate = 0;
  
  // PATCH: helpers for child-mesh IDs (same as viewer.js)
  const MESH_TAG = '::mesh::';
  function getChildTokenFromId(id) {
    const i = id.lastIndexOf(MESH_TAG);
    return i >= 0 ? id.slice(i + MESH_TAG.length) : null;
  }

  // Custom Logic Manager for executing user scripts (synced with viewer.js)
  class CustomLogicManager {
    constructor(scene) {
      this.scene = scene;
      this.activeLogics = new Map(); // objectId -> array of logic instances
      console.log('🧠 CustomLogicManager initialized');
    }

    async loadCustomLogics(customLogicData) {
      if (!customLogicData || !customLogicData.objectLogics) {
        console.log('🧠 No custom logic data provided');
        return;
      }

      console.log('🧠 Loading custom logics:', customLogicData.objectLogics);

      for (const [objectId, logics] of Object.entries(customLogicData.objectLogics)) {
        // Handle scene-level logic (objectId === '__scene__')
        let babylonObject;
        if (objectId === '__scene__') {
          babylonObject = this.scene;
          console.log('🧠 Attaching logic to scene itself');
        } else {
          babylonObject = this.scene.getNodeById(objectId);
          
          if (!babylonObject) {
            console.warn('🧠 Object ' + objectId + ' not found in scene, skipping logic');
            continue;
          }
        }

        const objectLogics = [];

        for (const logicData of logics) {
          if (!logicData.enabled) {
            console.log('🧠 Logic ' + logicData.scriptName + ' disabled, skipping');
            continue;
          }

          try {
            // Execute the script content to get the class
            const LogicClass = this.executeScript(logicData.scriptContent);
            
            if (!LogicClass) {
              console.error('🧠 Failed to load logic class from ' + logicData.scriptName);
              continue;
            }

            // Create instance and set parameters
            console.log('🧠 Creating instance of LogicClass:', LogicClass);
            const logicInstance = new LogicClass();
            console.log('🧠 Logic instance created:', logicInstance);
            
            // Check if attach method exists
            if (typeof logicInstance.attach !== 'function') {
              console.error('🧠 Logic instance does not have attach method:', logicInstance);
              continue;
            }
            
            // Set parameters in the params object (new static inspector format)
            logicInstance.params = logicData.parameters;
            console.log('🧠 Set params for ' + logicData.scriptName + ':', logicData.parameters);
            
            // Also set parameters directly for backward compatibility with old format
            Object.keys(logicData.parameters).forEach(function(key) {
              logicInstance[key] = logicData.parameters[key];
            });

            // Create context with proper scope handling (same as viewer.js)
            const scene = this.scene;
            const context = {
              scene: scene,
              engine: scene.getEngine(),
              resolveAsset: function(ref) { return ref; }, // Simple passthrough for now
              getByRef: function(nodeRef) {
                // Handle nodeRef parameter - can be object ID or object reference
                if (!nodeRef) return null;
                
                // If it's already a Babylon object, return it
                if (nodeRef.dispose && typeof nodeRef.dispose === 'function') {
                  return nodeRef;
                }
                
                // If it's an object with id property (from CustomLogic UI)
                if (typeof nodeRef === 'object' && nodeRef.id) {
                  return scene.getNodeById(nodeRef.id);
                }
                
                // If it's a string ID directly
                if (typeof nodeRef === 'string') {
                  return scene.getNodeById(nodeRef);
                }
                
                console.warn('🧠 getByRef: Unrecognized nodeRef format:', nodeRef);
                return null;
              },
              getUIElement: function(uiElementRef, maxWaitMs) {
                // Handle uiElement parameter - can be object with id or string ID
                // Returns a Promise that resolves when the element is found (waits for spatial UI to render)
                if (maxWaitMs === undefined) maxWaitMs = 5000;
                
                return new Promise(function(resolve, reject) {
                  if (!uiElementRef) {
                    resolve(null);
                    return;
                  }
                  
                  if (!window.uiLoader) {
                    console.warn('🧠 getUIElement: UI loader not available');
                    resolve(null);
                    return;
                  }
                  
                  // Extract the UI element ID
                  var elementId;
                  if (typeof uiElementRef === 'object' && uiElementRef.id) {
                    elementId = uiElementRef.id;
                  } else if (typeof uiElementRef === 'string') {
                    elementId = uiElementRef;
                  } else {
                    console.warn('🧠 getUIElement: Unrecognized uiElement format:', uiElementRef);
                    resolve(null);
                    return;
                  }
                  
                  // Try to find element immediately
                  var tryFindElement = function() {
                    // First, try spatial (anchored) version
                    var spatialElement = document.querySelector('[data-ui-element-id="' + elementId + '"][data-spatial-ui="true"]');
                    if (spatialElement) {
                      console.log('🧠 getUIElement: Found spatial UI for ' + elementId);
                      return spatialElement;
                    }
                    
                    // Otherwise, try screen UI version
                    var element = window.uiLoader.getElement(elementId);
                    if (element) {
                      console.log('🧠 getUIElement: Found screen UI for ' + elementId);
                      return element;
                    }
                    
                    return null;
                  };
                  
                  // Try immediately
                  var element = tryFindElement();
                  if (element) {
                    resolve(element);
                    return;
                  }
                  
                  // If not found, poll for it (spatial UI might not be rendered yet)
                  console.log('🧠 getUIElement: Element ' + elementId + ' not found immediately, polling...');
                  var startTime = Date.now();
                  var pollInterval = setInterval(function() {
                    var foundElement = tryFindElement();
                    
                    if (foundElement) {
                      clearInterval(pollInterval);
                      console.log('🧠 getUIElement: Found ' + elementId + ' after ' + (Date.now() - startTime) + 'ms');
                      resolve(foundElement);
                    } else if (Date.now() - startTime > maxWaitMs) {
                      clearInterval(pollInterval);
                      console.warn('🧠 getUIElement: Element ' + elementId + ' not found after ' + maxWaitMs + 'ms');
                      resolve(null);
                    }
                  }, 100); // Check every 100ms
                });
              }
            };

            // Attach to the Babylon object
            console.log('🧠 Attaching logic to object:', babylonObject.name || babylonObject.id);
            console.log('🧠 Context:', context);
            
            try {
              logicInstance.attach(babylonObject, context);
              console.log('🧠 Attach method called successfully');
            } catch (attachError) {
              console.error('🧠 Error calling attach method:', attachError);
              continue;
            }
            
            objectLogics.push({
              instance: logicInstance,
              scriptName: logicData.scriptName,
              enabled: logicData.enabled
            });
            
            console.log('✅ Successfully loaded and attached logic: ' + logicData.scriptName + ' to ' + (babylonObject.name || babylonObject.id));
          } catch (error) {
            console.error('🧠 Error loading logic ' + logicData.scriptName + ':', error);
          }
        }

        if (objectLogics.length > 0) {
          this.activeLogics.set(objectId, objectLogics);
        }
      }

      console.log('🧠 Successfully loaded ' + this.activeLogics.size + ' objects with custom logic');
    }

    executeScript(scriptContent) {
      try {
        console.log('🧠 Executing script content length:', scriptContent.length);
        console.log('🧠 First 200 chars of script:', scriptContent.substring(0, 200));
        
        let transformedScript = scriptContent;
        
        // Check if this is TypeScript syntax (has export or type annotations)
        const isTypeScript = /exports+defaults+class|:s*w+s*=/.test(scriptContent);
        
        if (isTypeScript) {
          console.log('🧠 Detected TypeScript syntax, transforming...');
          
          // Transform TypeScript to JavaScript (same as viewer.js)
          transformedScript = transformedScript.replace(/exports+defaults+classs+(w+)/g, 'class $1');
          transformedScript = transformedScript.replace(/(w+):s*[w[]|'"s<>()]+(s*=s*[^;]+;)/g, '$1$2');
          transformedScript = transformedScript.replace(/(w+)s*([^)]*:s*[^)]+)/g, function(match, methodName) {
            const paramMatch = match.match(/(([^)]+))/);
            if (paramMatch) {
              const params = paramMatch[1].split(',').map(function(param) {
                const paramName = param.trim().split(':')[0].trim();
                return paramName;
              }).join(', ');
              return methodName + '(' + params + ')';
            }
            return match;
          });
          transformedScript = transformedScript.replace(/Array<[^>]+>/g, 'Array');
          transformedScript = transformedScript.replace(/(private|public|protected)s+/g, '');
          
          console.log('🧠 Transformed TypeScript to JavaScript');
        }
        
        // Create a function that returns the class (simplified approach)
        console.log('🧠 Creating script function with transformed script:', transformedScript);
        
        // Build the function body step by step to avoid escaping issues
        var functionBody = transformedScript;
        functionBody += '\n\n';
        functionBody += 'if (typeof CustomLogic === "undefined") {\n';
        functionBody += '  console.error("🧠 CustomLogic class not found in script");\n';
        functionBody += '  return null;\n';
        functionBody += '}\n';
        functionBody += 'console.log("🧠 CustomLogic class found:", CustomLogic);\n';
        functionBody += 'return CustomLogic;';
        
        const scriptFunction = new Function('BABYLON', functionBody);
        
        // Execute with BABYLON as parameter
        const LogicClass = scriptFunction(BABYLON);
        console.log('🧠 Script function returned:', LogicClass);
        return LogicClass;
      } catch (error) {
        console.error('🧠 Script execution error:', error);
        console.error('🧠 Script content:', scriptContent);
        return null;
      }
    }

    update(deltaTime) {
      // Update all active logic instances
      for (const [objectId, logics] of this.activeLogics) {
        for (const logicData of logics) {
          if (logicData.enabled && logicData.instance && typeof logicData.instance.update === 'function') {
            try {
              logicData.instance.update(deltaTime);
            } catch (error) {
              console.error('🧠 Error updating logic ' + logicData.scriptName + ':', error);
            }
          }
        }
      }
    }

    dispose() {
      console.log('🧠 Disposing custom logic manager...');
      
      for (const [objectId, logics] of this.activeLogics) {
        for (const logic of logics) {
          try {
            if (logic.instance && typeof logic.instance.dispose === 'function') {
              logic.instance.dispose();
            }
          } catch (error) {
            console.error('🧠 Error disposing logic ' + logic.scriptName + ':', error);
          }
        }
      }
      
      this.activeLogics.clear();
      console.log('🧠 Custom logic manager disposed');
    }
  }

  // UI Loader for rendering UI elements (synced with viewer.js)
  class UILoader {
    constructor(scene, engine, sceneGraph) {
      this.scene = scene;
      this.engine = engine;
      this.sceneGraph = sceneGraph; // For spatial UI detection
      this.elements = [];
      this.elementMap = new Map();
      this.container = null;
      this.globalAnimations = [];
      this.screenSizeSettings = {
        mobile: { enabled: false, width: 768 },
        tablet: { enabled: false, width: 1024 }
      };
      console.log('🎨 UILoader initialized');
    }

    async loadUI() {
      try {
        // Try to load animations.json from local path
        try {
          const animResponse = await fetch('./UI/animations.json', { cache: 'no-store' });
          if (animResponse.ok) {
            const animData = await animResponse.json();
            this.globalAnimations = animData.animations || [];
            console.log('✅ Loaded ' + this.globalAnimations.length + ' global animations');
            this.injectAnimationStyles();
          }
        } catch (error) {
          console.log('ℹ️ No animations.json found');
        }
        
        // Try to load ui.json from local path
        const response = await fetch('./UI/ui.json', {
          cache: 'no-store',
          headers: { 'Cache-Control': 'no-cache' }
        });
        
        if (!response.ok) {
          console.log('ℹ️ No UI configuration found');
          return false;
        }
        
        const uiConfig = await response.json();
        
        // Filter out anchored UI elements - they're rendered in 3D space, not as screen overlay
        const anchoredUIIds = new Set();
        
        // Get anchored UI IDs from scene graph (excluding deleted ones)
        if (this.sceneGraph && this.sceneGraph.nodes) {
          this.sceneGraph.nodes.forEach(function(node) {
            if (node.kind === 'spatialui' && node.spatialUI && node.spatialUI.linkedUIElementId && !(node.metadata && node.metadata.deleted === true)) {
              anchoredUIIds.add(node.spatialUI.linkedUIElementId);
            }
          });
        }
        
        // Filter out anchored elements
        this.elements = (uiConfig.elements || []).filter(function(el) {
          return !el.anchoredTo && !anchoredUIIds.has(el.id);
        });
        
        // Load screen size settings
        if (uiConfig.screenSizeSettings) {
          this.screenSizeSettings = uiConfig.screenSizeSettings;
          console.log('✅ Loaded screen size settings:', this.screenSizeSettings);
        }
        
        console.log('✅ Loaded ' + this.elements.length + ' UI elements (anchored elements excluded)');
        return true;
      } catch (error) {
        console.log('ℹ️ No UI to load:', error.message);
        return false;
      }
    }

    initializeUI(canvasElement) {
      if (!canvasElement || this.elements.length === 0) return;
      
      // Create UI overlay container
      this.container = document.createElement('div');
      this.container.id = 'ui-overlay';
      this.container.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        pointer-events: none;
        z-index: 1000;
        display: grid;
        grid-template-columns: 1fr;
        grid-template-rows: 1fr;
        width: 100%;
        height: 100%;
        align-items: start;
        justify-items: start;
      `;
      
      // Insert after canvas
      canvasElement.parentElement.appendChild(this.container);
      
      // Build hierarchy and maintain array order
      var byParent = new Map();
      this.elements.forEach(function(el) {
        var parentKey = el.parentId || null;
        if (!byParent.has(parentKey)) {
          byParent.set(parentKey, []);
        }
        byParent.get(parentKey).push(el);
      });
      
      // Sort each group: overlays last (render on top)
      byParent.forEach(function(elements) {
        elements.sort(function(a, b) {
          var aIsOverlay = a.isOverlay ?? false;
          var bIsOverlay = b.isOverlay ?? false;
          
          if (aIsOverlay && !bIsOverlay) return 1;
          if (!aIsOverlay && bIsOverlay) return -1;
          return 0;
        });
      });
      
      // Render root elements
      var rootElements = byParent.get(null) || [];
      var self = this;
      rootElements.forEach(function(element) {
        if (element.visible !== false) {
          var domElement = self.renderElement(element, byParent);
          if (domElement) {
            self.container.appendChild(domElement);
            self.elementMap.set(element.id, domElement);
          }
        }
      });
      
      console.log('✅ UI initialized with ' + this.elementMap.size + ' elements');
    }

    renderElement(element, byParent) {
      // Skip rendering overlay elements
      if (element.isOverlay) return null;
      
      var allChildren = byParent.get(element.id) || [];
      var children = allChildren.filter(function(child) { return !child.isOverlay; });
      var hasChildren = children.length > 0;
      var isRootElement = !element.parentId;
      
      var domElement;
      switch (element.type) {
        case 'button':
          domElement = document.createElement('button');
          domElement.textContent = element.content?.text || '';
          break;
        case 'text':
          domElement = document.createElement('div');
          domElement.textContent = element.content?.text || 'Text';
          break;
        case 'box':
          domElement = document.createElement('div');
          break;
        case 'image':
          domElement = document.createElement('img');
          if (element.content?.imageUrl) {
            // In exported version, images are in assets/ folder with their relative path preserved
            var imageUrl = element.content.imageUrl;
            if (!imageUrl.startsWith('http')) {
              // Extract relative path from storage path (e.g., userId/projects/projectId/assets/image.png -> image.png)
              var pathParts = imageUrl.split('/');
              var assetsIndex = pathParts.lastIndexOf('assets');
              if (assetsIndex >= 0 && assetsIndex < pathParts.length - 1) {
                // Get everything after 'assets/' to preserve subdirectories
                var relativePath = pathParts.slice(assetsIndex + 1).join('/');
                // URL encode each path segment to handle spaces and special characters
                imageUrl = './assets/' + relativePath.split('/').map(function(p) { return encodeURIComponent(p); }).join('/');
              } else {
                // Fallback: just use filename
                imageUrl = './assets/' + encodeURIComponent(pathParts[pathParts.length - 1]);
              }
            }
            domElement.src = imageUrl;
            console.log('🖼️ Loading image:', imageUrl);
          }
          domElement.alt = element.name || 'Image';
          domElement.style.width = '100%';
          domElement.style.height = '100%';
          domElement.style.objectFit = 'contain';
          break;
        case 'input':
          domElement = document.createElement('input');
          domElement.type = 'text';
          domElement.placeholder = element.content?.placeholder || '';
          break;
        default:
          domElement = document.createElement('div');
      }
      
      domElement.id = element.id;
      domElement.dataset.uiName = element.name;
      domElement.dataset.uiType = element.type;
      
      this.applyStyles(domElement, element.style, hasChildren, isRootElement);
      
      // Apply animations
      if (element.assignedAnimations && element.assignedAnimations.length > 0) {
        var animationDurations = element.animationDurations || {};
        var animationNames = [];
        var animationDurationsList = [];
        var self = this;
        
        element.assignedAnimations.forEach(function(animId) {
          var animation = self.globalAnimations.find(function(anim) { return anim.id === animId; });
          if (animation) {
            animationNames.push(animation.internalName);
            animationDurationsList.push((animationDurations[animId] || '1') + 's');
          }
        });
        
        if (animationNames.length > 0) {
          domElement.style.animation = animationNames.map(function(name, i) {
            return name + ' ' + animationDurationsList[i] + ' infinite';
          }).join(', ');
        }
      }
      
      // Apply hover and active state styles
      if (element.hoverStyle || element.activeStyle || element.mobileStyle || element.mobileHoverStyle || element.mobileActiveStyle || element.tabletStyle || element.tabletHoverStyle || element.tabletActiveStyle) {
        this.applyPseudoStates(domElement, element);
      }
      
      // Apply effects
      if (element.effects && element.effects.length > 0) {
        this.applyEffects(domElement, element.effects);
        this.applyPseudoEffects(domElement, element);
      }
      
      // Handle visibility
      if (element.visible === false) {
        domElement.style.display = 'none';
      }
      
      if (element.enabled !== false) {
        domElement.style.pointerEvents = 'auto';
      }
      
      // Custom logic support
      var self = this;
      if (element.customLogic) {
        try {
          var handler = new Function('element', 'scene', 'engine', element.customLogic);
          domElement.addEventListener('click', function(e) {
            e.stopPropagation();
            handler(domElement, self.scene, self.engine);
          });
        } catch (error) {
          console.error('Failed to attach custom logic to ' + element.id, error);
        }
      }
      
      // Render overlay
      var overlay = allChildren.find(function(child) { return child.isOverlay; });
      if (overlay && overlay.visible !== false) {
        var overlayEl = document.createElement('div');
        overlayEl.classList.add('ui-overlay');
        this.applyStyles(overlayEl, overlay.style || {}, false, false);
        if (overlay.effects && overlay.effects.length > 0) {
          this.applyEffects(overlayEl, overlay.effects);
          this.applyPseudoEffects(overlayEl, overlay);
        }
        overlayEl.style.position = 'absolute';
        overlayEl.style.pointerEvents = 'none';
        overlayEl.style.margin = '0';
        overlayEl.style.padding = '0';
        overlayEl.style.gap = '0';
        overlayEl.style.boxSizing = 'border-box';
        domElement.appendChild(overlayEl);
      }
      
      // Render children
      var self = this;
      children.forEach(function(child) {
        if (child.visible !== false) {
          var childElement = self.renderElement(child, byParent);
          if (childElement) {
            domElement.appendChild(childElement);
            self.elementMap.set(child.id, childElement);
          }
        }
      });
      
      return domElement;
    }

    applyPseudoStates(domElement, element) {
      var self = this;
      var uniqueClass = 'ui-element-' + element.id;
      domElement.classList.add(uniqueClass);
      
      if (element.hoverStyle || element.activeStyle || element.mobileStyle || element.mobileHoverStyle || element.mobileActiveStyle || element.tabletStyle || element.tabletHoverStyle || element.tabletActiveStyle) {
        domElement.style.pointerEvents = 'auto';
      }
      
      var cssRules = '';
      
      // Desktop styles (default)
      if (element.hoverStyle) {
        var hoverStyles = Object.entries(element.hoverStyle)
          .map(function([key, value]) {
            var cssKey = key.replace(/([A-Z])/g, '-$1').toLowerCase();
            return cssKey + ': ' + value + ' !important;';
          })
          .join(' ');
        cssRules += '.' + uniqueClass + ':hover { ' + hoverStyles + ' }\n';
      }
      
      if (element.activeStyle) {
        var activeStyles = Object.entries(element.activeStyle)
          .map(function([key, value]) {
            var cssKey = key.replace(/([A-Z])/g, '-$1').toLowerCase();
            return cssKey + ': ' + value + ' !important;';
          })
          .join(' ');
        cssRules += '.' + uniqueClass + ':active { ' + activeStyles + ' }\n';
      }
      
      // Mobile styles (if enabled)
      if (this.screenSizeSettings.mobile.enabled) {
        var mobileMaxWidth = this.screenSizeSettings.mobile.width;
        
        if (element.mobileStyle) {
          var mobileStyles = Object.entries(element.mobileStyle)
            .map(function([key, value]) {
              var cssKey = key.replace(/([A-Z])/g, '-$1').toLowerCase();
              return cssKey + ': ' + value + ' !important;';
            })
            .join(' ');
          cssRules += '@media (max-width: ' + mobileMaxWidth + 'px) { .' + uniqueClass + ' { ' + mobileStyles + ' } }\n';
        }
        
        if (element.mobileHoverStyle) {
          var mobileHoverStyles = Object.entries(element.mobileHoverStyle)
            .map(function([key, value]) {
              var cssKey = key.replace(/([A-Z])/g, '-$1').toLowerCase();
              return cssKey + ': ' + value + ' !important;';
            })
            .join(' ');
          cssRules += '@media (max-width: ' + mobileMaxWidth + 'px) { .' + uniqueClass + ':hover { ' + mobileHoverStyles + ' } }\n';
        }
        
        if (element.mobileActiveStyle) {
          var mobileActiveStyles = Object.entries(element.mobileActiveStyle)
            .map(function([key, value]) {
              var cssKey = key.replace(/([A-Z])/g, '-$1').toLowerCase();
              return cssKey + ': ' + value + ' !important;';
            })
            .join(' ');
          cssRules += '@media (max-width: ' + mobileMaxWidth + 'px) { .' + uniqueClass + ':active { ' + mobileActiveStyles + ' } }\n';
        }
      }
      
      // Tablet styles (if enabled)
      if (this.screenSizeSettings.tablet.enabled) {
        var tabletMaxWidth = this.screenSizeSettings.tablet.width;
        var mobileMaxWidth = this.screenSizeSettings.mobile.enabled ? this.screenSizeSettings.mobile.width : 0;
        
        // Tablet styles should apply between mobile and tablet breakpoints
        var minWidth = this.screenSizeSettings.mobile.enabled ? mobileMaxWidth + 1 : 0;
        var mediaQuery = minWidth > 0 
          ? '@media (min-width: ' + minWidth + 'px) and (max-width: ' + tabletMaxWidth + 'px)' 
          : '@media (max-width: ' + tabletMaxWidth + 'px)';
        
        if (element.tabletStyle) {
          var tabletStyles = Object.entries(element.tabletStyle)
            .map(function([key, value]) {
              var cssKey = key.replace(/([A-Z])/g, '-$1').toLowerCase();
              return cssKey + ': ' + value + ' !important;';
            })
            .join(' ');
          cssRules += mediaQuery + ' { .' + uniqueClass + ' { ' + tabletStyles + ' } }\n';
        }
        
        if (element.tabletHoverStyle) {
          var tabletHoverStyles = Object.entries(element.tabletHoverStyle)
            .map(function([key, value]) {
              var cssKey = key.replace(/([A-Z])/g, '-$1').toLowerCase();
              return cssKey + ': ' + value + ' !important;';
            })
            .join(' ');
          cssRules += mediaQuery + ' { .' + uniqueClass + ':hover { ' + tabletHoverStyles + ' } }\n';
        }
        
        if (element.tabletActiveStyle) {
          var tabletActiveStyles = Object.entries(element.tabletActiveStyle)
            .map(function([key, value]) {
              var cssKey = key.replace(/([A-Z])/g, '-$1').toLowerCase();
              return cssKey + ': ' + value + ' !important;';
            })
            .join(' ');
          cssRules += mediaQuery + ' { .' + uniqueClass + ':active { ' + tabletActiveStyles + ' } }\n';
        }
      }
      
      if (cssRules) {
        var styleTag = document.getElementById('ui-pseudo-states');
        if (!styleTag) {
          styleTag = document.createElement('style');
          styleTag.id = 'ui-pseudo-states';
          document.head.appendChild(styleTag);
        }
        styleTag.textContent += cssRules;
      }
    }

    applyEffects(domElement, effects) {
      var filters = [];
      var shadows = [];
      
      effects.forEach(function(effect) {
        if (effect.enabled === false) return;
        
        switch (effect.type) {
          case 'dropShadow':
            shadows.push((effect.shadowX || '0px') + ' ' + (effect.shadowY || '0px') + ' ' + (effect.shadowBlur || '0px') + ' ' + (effect.shadowSpread || '0px') + ' ' + (effect.shadowColor || 'rgba(0,0,0,0.25)'));
            break;
          case 'innerShadow':
            shadows.push('inset ' + (effect.shadowX || '0px') + ' ' + (effect.shadowY || '0px') + ' ' + (effect.shadowBlur || '0px') + ' ' + (effect.shadowSpread || '0px') + ' ' + (effect.shadowColor || 'rgba(0,0,0,0.25)'));
            break;
          case 'blur':
            filters.push('blur(' + (effect.blurAmount || '0px') + ')');
            break;
          case 'frostedBackground':
            domElement.style.backdropFilter = 'blur(' + (effect.frostedBlur || '10px') + ')';
            if (!domElement.style.backgroundColor) {
              domElement.style.backgroundColor = 'rgba(255,255,255,' + (effect.frostedOpacity || 0.8) + ')';
            }
            break;
        }
      });
      
      if (shadows.length > 0) {
        domElement.style.boxShadow = shadows.join(', ');
      }
      if (filters.length > 0) {
        domElement.style.filter = filters.join(' ');
      }
    }

    applyPseudoEffects(domElement, element) {
      var self = this;
      var uniqueClass = 'ui-element-' + element.id;
      domElement.classList.add(uniqueClass);
      
      var cssRules = '';
      
      // Helper function to generate effect CSS for a given settings key
      var generateEffectCSS = function(settingsKey) {
        var filters = [];
        var shadows = [];
        var backdropBlur = null;
        
        element.effects.forEach(function(effect) {
          if (effect.enabled === false) return;
          
          var getVal = function(prop) {
            return effect[settingsKey]?.[prop] !== undefined ? effect[settingsKey][prop] : effect[prop];
          };
          
          switch (effect.type) {
            case 'dropShadow':
              shadows.push((getVal('shadowX') || '0px') + ' ' + (getVal('shadowY') || '0px') + ' ' + (getVal('shadowBlur') || '0px') + ' ' + (getVal('shadowSpread') || '0px') + ' ' + (getVal('shadowColor') || 'rgba(0,0,0,0.25)'));
              break;
            case 'innerShadow':
              shadows.push('inset ' + (getVal('shadowX') || '0px') + ' ' + (getVal('shadowY') || '0px') + ' ' + (getVal('shadowBlur') || '0px') + ' ' + (getVal('shadowSpread') || '0px') + ' ' + (getVal('shadowColor') || 'rgba(0,0,0,0.25)'));
              break;
            case 'blur':
              filters.push('blur(' + (getVal('blurAmount') || '0px') + ')');
              break;
            case 'frostedBackground':
              backdropBlur = 'blur(' + (getVal('frostedBlur') || '10px') + ')';
              break;
          }
        });
        
        var effectStyles = '';
        if (shadows.length > 0) effectStyles += 'box-shadow: ' + shadows.join(', ') + ' !important;';
        if (filters.length > 0) effectStyles += 'filter: ' + filters.join(' ') + ' !important;';
        if (backdropBlur) effectStyles += 'backdrop-filter: ' + backdropBlur + ' !important;';
        
        return effectStyles;
      };
      
      // Check if any effect has settings for any state
      var hasHoverSettings = element.effects.some(function(eff) { 
        return eff.hoverSettings && Object.keys(eff.hoverSettings).length > 0; 
      });
      var hasActiveSettings = element.effects.some(function(eff) { 
        return eff.activeSettings && Object.keys(eff.activeSettings).length > 0; 
      });
      var hasMobileSettings = element.effects.some(function(eff) { 
        return eff.mobileSettings && Object.keys(eff.mobileSettings).length > 0; 
      });
      var hasMobileHoverSettings = element.effects.some(function(eff) { 
        return eff.mobileHoverSettings && Object.keys(eff.mobileHoverSettings).length > 0; 
      });
      var hasMobileActiveSettings = element.effects.some(function(eff) { 
        return eff.mobileActiveSettings && Object.keys(eff.mobileActiveSettings).length > 0; 
      });
      var hasTabletSettings = element.effects.some(function(eff) { 
        return eff.tabletSettings && Object.keys(eff.tabletSettings).length > 0; 
      });
      var hasTabletHoverSettings = element.effects.some(function(eff) { 
        return eff.tabletHoverSettings && Object.keys(eff.tabletHoverSettings).length > 0; 
      });
      var hasTabletActiveSettings = element.effects.some(function(eff) { 
        return eff.tabletActiveSettings && Object.keys(eff.tabletActiveSettings).length > 0; 
      });
      
      if (hasHoverSettings || hasActiveSettings || hasMobileHoverSettings || hasMobileActiveSettings || hasTabletHoverSettings || hasTabletActiveSettings) {
        domElement.style.pointerEvents = 'auto';
      }
      
      // Desktop hover effects
      if (hasHoverSettings) {
        var hoverStyles = generateEffectCSS('hoverSettings');
        if (hoverStyles) {
          cssRules += '.' + uniqueClass + ':hover { ' + hoverStyles + ' }\n';
        }
      }
      
      // Desktop active effects
      if (hasActiveSettings) {
        var activeStyles = generateEffectCSS('activeSettings');
        if (activeStyles) {
          cssRules += '.' + uniqueClass + ':active { ' + activeStyles + ' }\n';
        }
      }
      
      // Mobile effects (if enabled)
      if (this.screenSizeSettings.mobile.enabled) {
        var mobileMaxWidth = this.screenSizeSettings.mobile.width;
        
        if (hasMobileSettings) {
          var mobileStyles = generateEffectCSS('mobileSettings');
          if (mobileStyles) {
            cssRules += '@media (max-width: ' + mobileMaxWidth + 'px) { .' + uniqueClass + ' { ' + mobileStyles + ' } }\n';
          }
        }
        
        if (hasMobileHoverSettings) {
          var mobileHoverStyles = generateEffectCSS('mobileHoverSettings');
          if (mobileHoverStyles) {
            cssRules += '@media (max-width: ' + mobileMaxWidth + 'px) { .' + uniqueClass + ':hover { ' + mobileHoverStyles + ' } }\n';
          }
        }
        
        if (hasMobileActiveSettings) {
          var mobileActiveStyles = generateEffectCSS('mobileActiveSettings');
          if (mobileActiveStyles) {
            cssRules += '@media (max-width: ' + mobileMaxWidth + 'px) { .' + uniqueClass + ':active { ' + mobileActiveStyles + ' } }\n';
          }
        }
      }
      
      // Tablet effects (if enabled)
      if (this.screenSizeSettings.tablet.enabled) {
        var tabletMaxWidth = this.screenSizeSettings.tablet.width;
        var mobileMaxWidth = this.screenSizeSettings.mobile.enabled ? this.screenSizeSettings.mobile.width : 0;
        
        // Tablet effects should apply between mobile and tablet breakpoints
        var minWidth = this.screenSizeSettings.mobile.enabled ? mobileMaxWidth + 1 : 0;
        var mediaQuery = minWidth > 0 
          ? '@media (min-width: ' + minWidth + 'px) and (max-width: ' + tabletMaxWidth + 'px)' 
          : '@media (max-width: ' + tabletMaxWidth + 'px)';
        
        if (hasTabletSettings) {
          var tabletStyles = generateEffectCSS('tabletSettings');
          if (tabletStyles) {
            cssRules += mediaQuery + ' { .' + uniqueClass + ' { ' + tabletStyles + ' } }\n';
          }
        }
        
        if (hasTabletHoverSettings) {
          var tabletHoverStyles = generateEffectCSS('tabletHoverSettings');
          if (tabletHoverStyles) {
            cssRules += mediaQuery + ' { .' + uniqueClass + ':hover { ' + tabletHoverStyles + ' } }\n';
          }
        }
        
        if (hasTabletActiveSettings) {
          var tabletActiveStyles = generateEffectCSS('tabletActiveSettings');
          if (tabletActiveStyles) {
            cssRules += mediaQuery + ' { .' + uniqueClass + ':active { ' + tabletActiveStyles + ' } }\n';
          }
        }
      }
      
      // Inject CSS rules
      if (cssRules) {
        var styleTag = document.getElementById('ui-pseudo-effects');
        if (!styleTag) {
          styleTag = document.createElement('style');
          styleTag.id = 'ui-pseudo-effects';
          document.head.appendChild(styleTag);
        }
        styleTag.textContent += cssRules;
      }
    }

    applyStyles(domElement, style, hasChildren, isRootElement) {
      var css = domElement.style;
      
      css.position = style.position || 'relative';
      css.display = style.display || (hasChildren ? 'flex' : 'inline-block');
      css.boxSizing = 'border-box';
      
      if (isRootElement) {
        css.gridColumn = '1';
        css.gridRow = '1';
      }
      
      // Positioning
      if (style.top) css.top = style.top;
      if (style.left) css.left = style.left;
      if (style.right) css.right = style.right;
      if (style.bottom) css.bottom = style.bottom;
      
      // Flex & Grid
      if (style.flexDirection) css.flexDirection = style.flexDirection;
      if (style.justifyContent) css.justifyContent = style.justifyContent;
      if (style.alignItems) css.alignItems = style.alignItems;
      if (style.alignSelf) css.alignSelf = style.alignSelf;
      if (style.justifySelf) css.justifySelf = style.justifySelf;
      if (style.gap) css.gap = style.gap;
      
      // Size with aspect-ratio support
      if (style.width) {
        if (typeof style.width === 'string' && style.width.includes('aspect-ratio')) {
          var ratio = style.width.replace('aspect-ratio', '').trim();
          css.aspectRatio = ratio || '1 / 1';
          css.width = 'auto';
        } else {
          css.width = style.width;
        }
      }
      if (style.height) {
        if (typeof style.height === 'string' && style.height.includes('aspect-ratio')) {
          var ratio = style.height.replace('aspect-ratio', '').trim();
          css.aspectRatio = ratio || '1 / 1';
          css.height = 'auto';
        } else {
          css.height = style.height;
        }
      }
      if (style.minWidth) css.minWidth = style.minWidth;
      if (style.minHeight) css.minHeight = style.minHeight;
      if (style.maxWidth) css.maxWidth = style.maxWidth;
      if (style.maxHeight) css.maxHeight = style.maxHeight;
      
      // Spacing
      if (style.margin) css.margin = style.margin;
      if (style.marginTop) css.marginTop = style.marginTop;
      if (style.marginRight) css.marginRight = style.marginRight;
      if (style.marginBottom) css.marginBottom = style.marginBottom;
      if (style.marginLeft) css.marginLeft = style.marginLeft;
      if (style.paddingTop) css.paddingTop = style.paddingTop;
      if (style.paddingRight) css.paddingRight = style.paddingRight;
      if (style.paddingBottom) css.paddingBottom = style.paddingBottom;
      if (style.paddingLeft) css.paddingLeft = style.paddingLeft;
      
      // Appearance
      if (style.backgroundColor) css.backgroundColor = style.backgroundColor;
      if (style.backgroundImage) {
        if (style.backgroundImage.startsWith('url(')) {
          var urlMatch = style.backgroundImage.match(/url\(['"]?(.+?)['"]?\)/);
          if (urlMatch && urlMatch[1]) {
            var imagePath = urlMatch[1];
            // In exported version, convert to assets/ path with relative path preserved
            var imageUrl;
            if (imagePath.startsWith('http')) {
              imageUrl = imagePath;
            } else {
              // Extract relative path from storage path (e.g., userId/projects/projectId/assets/Textures/image.png -> Textures/image.png)
              var pathParts = imagePath.split('/');
              var assetsIndex = pathParts.lastIndexOf('assets');
              if (assetsIndex >= 0 && assetsIndex < pathParts.length - 1) {
                // Get everything after 'assets/' to preserve subdirectories
                var relativePath = pathParts.slice(assetsIndex + 1).join('/');
                // URL encode each path segment to handle spaces and special characters
                imageUrl = './assets/' + relativePath.split('/').map(function(p) { return encodeURIComponent(p); }).join('/');
              } else {
                // Fallback: just use filename
                imageUrl = './assets/' + encodeURIComponent(pathParts[pathParts.length - 1]);
              }
            }
            css.backgroundImage = "url('" + imageUrl + "')";
          } else {
            css.backgroundImage = style.backgroundImage;
          }
          if (!style.backgroundColor) {
            css.backgroundColor = 'transparent';
          }
        } else {
          css.backgroundImage = style.backgroundImage;
        }
      }
      if (style.backgroundSize) css.backgroundSize = style.backgroundSize;
      if (style.backgroundPosition) css.backgroundPosition = style.backgroundPosition;
      if (style.backgroundRepeat) css.backgroundRepeat = style.backgroundRepeat;
      if (style.color) css.color = style.color;
      if (style.borderColor) css.borderColor = style.borderColor;
      if (style.borderWidth) {
        css.borderWidth = style.borderWidth;
        css.borderStyle = 'solid';
      }
      if (style.borderRadius) css.borderRadius = style.borderRadius;
      if (style.borderTopLeftRadius) css.borderTopLeftRadius = style.borderTopLeftRadius;
      if (style.borderTopRightRadius) css.borderTopRightRadius = style.borderTopRightRadius;
      if (style.borderBottomLeftRadius) css.borderBottomLeftRadius = style.borderBottomLeftRadius;
      if (style.borderBottomRightRadius) css.borderBottomRightRadius = style.borderBottomRightRadius;
      if (style.opacity !== undefined) css.opacity = style.opacity;
      
      // Typography
      if (style.fontFamily) css.fontFamily = style.fontFamily;
      if (style.fontSize) css.fontSize = style.fontSize;
      if (style.fontWeight) css.fontWeight = style.fontWeight;
      if (style.fontStyle) css.fontStyle = style.fontStyle;
      if (style.textAlign) css.textAlign = style.textAlign;
      if (style.lineHeight) css.lineHeight = style.lineHeight;
      if (style.letterSpacing) css.letterSpacing = style.letterSpacing;
      if (style.whiteSpace) css.whiteSpace = style.whiteSpace;
      if (style.wordBreak) css.wordBreak = style.wordBreak;
      if (style.overflowWrap) css.overflowWrap = style.overflowWrap;
      
      // Other
      if (style.transform) css.transform = style.transform;
      if (style.cursor) css.cursor = style.cursor;
      if (style.overflow) css.overflow = style.overflow;
      if (style.zIndex !== undefined) css.zIndex = style.zIndex;
      if (style.transition) css.transition = style.transition;
      if (style.pointerEvents) css.pointerEvents = style.pointerEvents;
      if (style.userSelect) css.userSelect = style.userSelect;
    }
    
    injectAnimationStyles() {
      var styleEl = document.getElementById('ui-animations-styles');
      if (!styleEl) {
        styleEl = document.createElement('style');
        styleEl.id = 'ui-animations-styles';
        document.head.appendChild(styleEl);
      }
      
      var css = '';
      this.globalAnimations.forEach(function(animation) {
        if (!animation.keyframes || animation.keyframes.length === 0) return;
        
        css += '@keyframes ' + animation.internalName + ' {\n';
        
        animation.keyframes.forEach(function(keyframe) {
          css += '  ' + keyframe.percentage + '% {\n';
          
          Object.entries(keyframe.properties).forEach(function([property, value]) {
            if (property === 'opacity') {
              css += '    opacity: ' + (value / 100) + ';\n';
            } else if (property === 'scale') {
              css += '    transform: scale(' + (value.x || 1) + ', ' + (value.y || 1) + ');\n';
            } else if (property === 'translate') {
              var unit = value.unit || 'px';
              css += '    transform: translate(' + (value.x || 0) + unit + ', ' + (value.y || 0) + unit + ');\n';
            } else if (property === 'rotation') {
              css += '    transform: rotate(' + value + 'deg);\n';
            } else if (property === 'background-color' || property === 'text-color' || property === 'border-color') {
              var cssProperty = property === 'text-color' ? 'color' : property;
              css += '    ' + cssProperty + ': ' + value + ';\n';
            } else if (property === 'width' || property === 'height') {
              if (typeof value === 'object') {
                css += '    ' + property + ': ' + value.value + (value.unit || 'px') + ';\n';
              } else {
                css += '    ' + property + ': ' + value + ';\n';
              }
            } else if (['border-radius', 'border-width', 'padding', 'margin', 'font-size', 'letter-spacing', 'line-height'].indexOf(property) >= 0) {
              if (typeof value === 'object') {
                css += '    ' + property + ': ' + value.value + (value.unit || 'px') + ';\n';
              } else {
                css += '    ' + property + ': ' + value + ';\n';
              }
            }
          });
          
          css += '  }\n';
        });
        
        css += '}\n\n';
      });
      
      styleEl.textContent = css;
      console.log('✅ Injected CSS animations');
    }

    getElement(id) {
      return this.elementMap.get(id);
    }

    dispose() {
      if (this.container && this.container.parentElement) {
        this.container.parentElement.removeChild(this.container);
      }
      this.elementMap.clear();
    }
  }

  // Show loading
  function showLoading(message) {
    const overlay = document.getElementById('loadingOverlay');
    const text = document.getElementById('loadingText');
    if (overlay && text) {
      overlay.classList.remove('hidden');
      text.textContent = message;
    }
    
    // Update progress bar
    const progressBarGlow = document.getElementById('progressBarGlow');
    const progressBarSolid = document.getElementById('progressBarSolid');
    if (progressBarGlow && progressBarSolid) {
      // Define loading steps
      const steps = [
        'Initializing viewer...',
        'Loading scene...',
        'Creating scene objects...',
        'Initializing physics...',
        'Applying scene settings...',
        'Preparing scene...',
        'Setting up input controls...',
        'Loading custom logic...',
        'Loading UI...',
        'Finalizing...'
      ];
      
      const stepIndex = steps.findIndex(function(step) { return step === message; });
      if (stepIndex >= 0) {
        const progress = ((stepIndex + 1) / steps.length) * 100;
        progressBarGlow.style.width = progress + '%';
        progressBarSolid.style.width = progress + '%';
      }
    }
  }

  // Hide loading
  function hideLoading() {
    const overlay = document.getElementById('loadingOverlay');
    if (overlay) {
      overlay.classList.add('hidden');
    }
  }

  // Show error
  function showError(message) {
    const overlay = document.getElementById('loadingOverlay');
    const text = document.getElementById('loadingText');
    if (overlay && text) {
      overlay.classList.remove('hidden');
      text.innerHTML = '<div class="error"><strong>Error:</strong><br>' + message + '</div>';
    }
  }

  // Texture helpers for overrides
  function isTextureProperty(prop) {
    const textureProps = [
      // PBR Material textures
      'albedoTexture', 'baseTexture',
      'metallicTexture', 'normalTexture',
      'emissiveTexture', 'opacityTexture',
      'ambientTexture', 'lightmapTexture',
      'reflectionTexture', 'refractionTexture',
      'clearCoatTexture', 'clearCoatNormalTexture', 'clearCoatRoughnessTexture',
      'sheenTexture', 'sheenRoughnessTexture',
      // Standard Material textures
      'diffuseTexture', 'specularTexture', 'bumpTexture'
    ];
    return textureProps.includes(prop);
  }

  // Extract a clean filename from a URL or path, removing query/hash and UUID prefixes
  function getFilenameFromUrl(url) {
    if (!url) return '';
    try {
      const lastPart = String(url).split('/').pop() || '';
      const clean = lastPart.split('?')[0].split('#')[0];
      // Remove UUID prefix in the form: 36-char uuid followed by underscore
      const uuidPattern = /^[a-f0-9-]{36}_(.+)$/i;
      const m = clean.match(uuidPattern);
      return m ? m[1] : clean;
    } catch {
      return '';
    }
  }

  function loadTextureFromAssetPath(assetStoragePath, scene) {
    if (!assetStoragePath || !scene) return null;
    try {
      console.log('🔍 RUNTIME: Loading texture from storage path:', assetStoragePath);
      
      // Use the toRelativeAssetPath function to convert storage path to relative path
      const url = toRelativeAssetPath(assetStoragePath);
      
      console.log('🔍 RUNTIME: Converted storage path to URL:', assetStoragePath, '->', url);
      
      const texture = new BABYLON.Texture(url, scene);
      const parts2 = url.split('/');
      texture.name = parts2[parts2.length - 1];
      return texture;
    } catch (e) {
      console.warn('❌ RUNTIME: Failed to load texture for override:', assetStoragePath, e);
      return null;
    }
  }

  try {
    showLoading('Initializing viewer...');
    
    // Create Babylon.js engine
    const engine = new BABYLON.Engine(canvas, true, {
      preserveDrawingBuffer: true,
      stencil: true,
    });
    engine.enableOfflineSupport = false;

    // Create scene
    const scene = new BABYLON.Scene(engine);
    // Match editor/viewer coordinate system so rotations are consistent
    scene.useRightHandedSystem = true;
    scene.clearColor = new BABYLON.Color4(0, 0, 0, 0); // Transparent background

    // Rely on Scene.useRightHandedSystem; Babylon's GLTF loader auto-aligns to scene

    showLoading('Loading scene...');
    
    // Load scene graph
    const response = await fetch('scene.json', { 
      cache: 'no-store', 
      headers: { 'Cache-Control': 'no-cache' } 
    });
    
    if (!response.ok) {
      throw new Error('Failed to fetch scene: ' + response.status + ' ' + response.statusText);
    }
    
    const sceneGraph = await response.json();
    console.log('Scene graph loaded:', sceneGraph);
    EXPORTED_SCENE_GRAPH = sceneGraph;

    // Validate scene graph
    if (!sceneGraph || !sceneGraph.nodes || !Array.isArray(sceneGraph.nodes)) {
      throw new Error('Invalid scene graph format');
    }

    showLoading('Creating scene objects...');
    
    // Initialize physics system early (like viewer.js does)
    const physics = sceneGraph.sceneSettings?.physics;
    if (physics && physics.enabled) {
      showLoading('Initializing physics...');
      try {
        console.log('🔷 Early physics initialization (like reference project)...');
        
        if (typeof Ammo !== 'undefined') {
          console.log('🔷 Initializing Ammo library...');
          window.AmmoLib = await Ammo();
          
          console.log('🔷 Creating AmmoJS plugin...');
          physicsPlugin = new BABYLON.AmmoJSPlugin();
          
          // Get the Ammo world for direct access
          const gravity = new BABYLON.Vector3(
            physics.gravity ? physics.gravity[0] : 0,
            physics.gravity ? physics.gravity[1] : -9.81,
            physics.gravity ? physics.gravity[2] : 0
          );
          scene.enablePhysics(gravity, physicsPlugin);
          
          // Store reference to Ammo world for raw colliders
          ammoWorld = physicsPlugin.world;
          
          console.log('✅ AmmoJS plugin enabled (reference project pattern)');
        } else {
          console.warn('⚠️ Ammo.js not available, physics disabled');
        }
      } catch (error) {
        console.error('❌ Failed to initialize physics:', error);
      }
    }
    
    // Instantiate scene from graph
    await instantiateGraph(sceneGraph, scene);

    // Apply scene settings if they exist
    if (sceneGraph.sceneSettings) {
      showLoading('Applying scene settings...');
      await applySceneSettings(scene, sceneGraph.sceneSettings);
    }

    showLoading('Preparing scene...');
    
    // Wait for scene to be ready
    await scene.whenReadyAsync();

    // Initialize input controls after scene is ready (like viewer.js timing)
    if (sceneGraph && sceneGraph.nodes) {
      showLoading('Setting up input controls...');
      inputControlManager = createInputControlManager(scene, sceneGraph);
      initializeInputControls(inputControlManager);
      console.log('🎮 Input control system initialized');
      
      // Initialize camera tracking for dynamic object targeting (exact viewer.js timing)
      // CRITICAL: Add delay to ensure parent relationships are fully established
      console.log('📹 Waiting for parent relationships to stabilize...');
      await new Promise(resolve => setTimeout(resolve, 100));
      cameraTrackingManager = createCameraTrackingManager(scene, sceneGraph);
      cameraTrackingManager.initialize();
      console.log('📹 Camera tracking system initialized');
      
      // Initialize camera shake for natural camera motion effects
      const cameraShakeManager = createCameraShakeManager(scene, sceneGraph);
      cameraShakeManager.initialize();
      console.log('📹 Camera shake system initialized');
      
          // Initialize camera collision for preventing wall clipping
      cameraCollisionManager = createCameraCollisionManager(scene, sceneGraph);
      cameraCollisionManager.initialize();
      console.log('📹 Camera collision system initialized');
      
      // Initialize FPS counter and audio system
      setupFpsCounter(engine, scene);
      setupAudioSystem(sceneGraph, scene);
    }

    // Apply material overrides after controls are initialized
    if (sceneGraph.materialOverrides) {
      showLoading('Applying material overrides...');
      // Add a longer delay to ensure all materials and textures including IBL are fully initialized
      await new Promise(resolve => setTimeout(resolve, 250));
      applyMaterialOverrides(scene, sceneGraph.materialOverrides);
    }

    // CRITICAL FIX: Final IBL material refresh after everything is loaded
    // This is what happens when you enable skybox in editor - it fixes the reflections!
    if (scene.environmentTexture) {
      console.log('🔧 Final IBL material refresh (replicates skybox creation fix)');
      setTimeout(() => {
        refreshMaterialsForIBL(scene);
        console.log('🎉 Runtime IBL reflections should now be correct!');
      }, 300);
    }

    // Start render loop
    engine.runRenderLoop(() => {
      if (scene) {
        scene.render();
        
        // Update custom logic instances
        if (customLogicManager) {
          customLogicManager.update(engine.getDeltaTime() / 1000); // Convert to seconds
        }
        
        // Update spatial UI positions
        if (updateSpatialUI) {
          updateSpatialUI();
        }
      }
    });

    // Handle window resize
    window.addEventListener('resize', () => {
      if (engine) {
        engine.resize();
      }
    });

    // Clean up on page unload
    window.addEventListener('beforeunload', () => {
      if (inputControlManager && inputControlManager.updateInterval) {
        clearInterval(inputControlManager.updateInterval);
        console.log('🎮 Input control manager cleaned up');
      }
      if (cameraTrackingManager) {
        cameraTrackingManager.dispose();
      }
      if (cameraCollisionManager) {
        cameraCollisionManager.dispose();
      }
      if (customLogicManager) {
        customLogicManager.dispose();
      }
      // Dispose audio elements
      if (audioNodes) {
        for (const audioNode of audioNodes) {
          if (audioNode.audioElement) {
            audioNode.audioElement.pause();
            audioNode.audioElement.src = '';
            audioNode.audioElement = null;
          }
        }
        audioNodes = [];
        audioInitialized = false;
      }
    });

    // Load custom logic data from customLogic.json file
    showLoading('Loading custom logic...');
    let customLogicData = null;
    
    try {
      console.log('🧠 Attempting to load custom logic from customLogic.json');
      const response = await fetch('customLogic.json', { 
        cache: 'no-store', 
        headers: { 'Cache-Control': 'no-cache' } 
      });
      
      if (response.ok) {
        customLogicData = await response.json();
        console.log('🧠 Loaded custom logic data from file:', customLogicData);
        
        // Load script contents from separate files
        if (customLogicData && customLogicData.objectLogics) {
          for (const [objectId, logics] of Object.entries(customLogicData.objectLogics)) {
            for (const logic of logics) {
              if (logic.scriptPath && !logic.scriptContent) {
                try {
                  console.log('🧠 Loading script file:', logic.scriptPath);
                  const scriptResponse = await fetch(logic.scriptPath, { 
                    cache: 'no-store', 
                    headers: { 'Cache-Control': 'no-cache' } 
                  });
                  
                  if (scriptResponse.ok) {
                    logic.scriptContent = await scriptResponse.text();
                    console.log('🧠 Loaded script content for:', logic.scriptName);
                  } else {
                    console.error('🧠 Failed to load script file:', logic.scriptPath, scriptResponse.status);
                  }
                } catch (error) {
                  console.error('🧠 Error loading script file:', logic.scriptPath, error);
                }
              }
            }
          }
        }
      } else if (response.status === 404) {
        console.log('🧠 No customLogic.json found - no custom logic to load');
      } else {
        console.error('🧠 Failed to load customLogic.json:', response.status, response.statusText);
      }
    } catch (error) {
      console.log('🧠 No custom logic data available (this is normal if no custom logic was added):', error.message);
    }

    // Initialize UI loader and load UI (MUST load BEFORE custom logic so scripts can reference UI elements)
    showLoading('Loading UI...');
    let uiLoader = null;
    if (scene && engine) {
      uiLoader = new UILoader(scene, engine, EXPORTED_SCENE_GRAPH);
      const uiLoaded = await uiLoader.loadUI();
      if (uiLoaded) {
        const canvas = document.getElementById('renderCanvas');
        uiLoader.initializeUI(canvas);
        console.log('🎨 UI system initialized');
      } else {
        console.log('ℹ️ No UI to load');
      }
      // Make uiLoader globally available for custom logic
      window.uiLoader = uiLoader;
    }

    // ============================================================================
    // Spatial UI Rendering - Render anchored UI in 3D space (synced with viewer.js)
    // ============================================================================
    
    if (scene && EXPORTED_SCENE_GRAPH) {
      console.log('🎨 Initializing Spatial UI rendering');
      
      // Create container for spatial UI elements
      spatialUIContainer = document.createElement('div');
      spatialUIContainer.id = 'spatial-ui-container';
      spatialUIContainer.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        z-index: 1000;
      `;
      document.body.appendChild(spatialUIContainer);
      
      // Map to track spatial UI DOM elements
      const spatialUIElements = new Map();
      
      // Replace the old updateSpatialUI with the proper one from viewer.js
      updateSpatialUI = function() {
        const camera = scene.activeCamera;
        
        if (!camera) return;
        
        // Find all spatial UI nodes from scene graph (excluding deleted ones)
        const spatialUINodesFromGraph = EXPORTED_SCENE_GRAPH.nodes.filter(function(node) {
          return node.kind === 'spatialui' && node.spatialUI && !(node.metadata && node.metadata.deleted === true);
        });
        
        spatialUINodesFromGraph.forEach(function(node) {
          const id = node.id;
          const spatialUI = node.spatialUI;
          const transform = node.transform;
          
          if (!spatialUI || !spatialUI.htmlContent) return;
          
          // Get or create container for this spatial UI
          let container = spatialUIElements.get(id);
          
          if (!container) {
            container = document.createElement('div');
            container.id = 'spatial-ui-container-' + id;
            container.style.position = 'absolute';
            container.style.zIndex = '10000';
            
            spatialUIContainer.appendChild(container);
            spatialUIElements.set(id, container);
          }
          
          // Update HTML content only if changed
          const htmlContent = spatialUI.htmlContent || '';
          if (container.dataset.lastHtml !== htmlContent) {
            // Parse the HTML and insert it
            container.innerHTML = htmlContent;
            container.dataset.lastHtml = htmlContent;
            
            // Get the root UI element (first child)
            const rootElement = container.firstElementChild;
            if (rootElement) {
              // CRITICAL: Override positioning properties to prevent double-positioning
              // Use direct style property assignment to preserve other inline styles like opacity
              rootElement.style.position = 'relative';
              rootElement.style.left = '';
              rootElement.style.top = '';
              rootElement.style.right = '';
              rootElement.style.bottom = '';
              rootElement.style.transform = '';
              
              // Mark all interactive elements with data attributes
              const interactiveElements = container.querySelectorAll('[id]');
              interactiveElements.forEach(function(child) {
                child.setAttribute('data-ui-element-id', child.id);
                child.setAttribute('data-spatial-ui', 'true');
                // Set pointer-events to auto if not explicitly set
                const inlineStyle = child.getAttribute('style') || '';
                if (!inlineStyle.includes('pointer-events')) {
                  child.style.pointerEvents = 'auto';
                }
              });
            }
          }
          
          const element = container;
          
          // Get 3D position from scene object
          const runtimeObject = scene.getNodeById(id);
          if (!runtimeObject) return;
          
          const anchorPos = runtimeObject.getAbsolutePosition();
          
          // Distance check
          const cameraPos = camera.position;
          const distance = BABYLON.Vector3.Distance(anchorPos, cameraPos);
          const maxDist = spatialUI.maxDistance !== undefined ? spatialUI.maxDistance : 100;
          const minDist = spatialUI.minDistance !== undefined ? spatialUI.minDistance : 0;
          const isInRange = distance >= minDist && distance <= maxDist;
          
          // Project 3D position to 2D screen coordinates
          const screenPos = BABYLON.Vector3.Project(
            anchorPos,
            BABYLON.Matrix.Identity(),
            scene.getTransformMatrix(),
            camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight())
          );
          
          // Check if in screen bounds
          const isInBounds =
            screenPos.x >= 0 &&
            screenPos.x <= engine.getRenderWidth() &&
            screenPos.y >= 0 &&
            screenPos.y <= engine.getRenderHeight();
          
          // Position element directly at anchor point
          element.style.left = screenPos.x + 'px';
          element.style.top = screenPos.y + 'px';
          element.style.transform = 'translate(-50%, -50%)';
          
          // Distance-based scaling
          if (spatialUI.scaleWithDistance) {
            const scale = Math.max(0.5, Math.min(2, 5 / distance));
            element.style.transform = 'translate(-50%, -50%) scale(' + scale + ')';
          }
          
          // Fade In/Out behavior: smoothly fade when entering/leaving range
          const rootUIElement = element.firstElementChild;
          const fadeEnabled = spatialUI.fadeInOut === true;
          
          // Store fade state on element
          if (!element._fadeState) {
            element._fadeState = {
              isVisible: false,
              originalOpacity: 1,
              hideTimeout: null
            };
          }
          const fadeState = element._fadeState;
          
          // Parse transition duration from root UI element's inline style
          var transitionMs = 300; // Default 300ms
          if (fadeEnabled && rootUIElement) {
            const inlineTransition = rootUIElement.style.transition;
            if (inlineTransition) {
              // Match patterns like "all 0.3s", "0.3s", "opacity 300ms", etc.
              const match = inlineTransition.match(/(\d+\.?\d*)(s|ms)/);
              if (match) {
                const value = parseFloat(match[1]);
                transitionMs = match[2] === 's' ? value * 1000 : value;
              }
            }
          }
          
          // Store original opacity from root UI element (only once)
          if (rootUIElement && fadeState.originalOpacity === 1) {
            const opacityStyle = rootUIElement.style.opacity;
            if (opacityStyle) {
              fadeState.originalOpacity = parseFloat(opacityStyle) || 1;
            }
          }
          
          if (!isInBounds || !isInRange) {
            // Out of range or bounds
            if (fadeEnabled && rootUIElement) {
              // Show element and fade out root UI element smoothly
              element.style.display = 'block';
              element.style.visibility = 'visible';
              rootUIElement.style.opacity = '0';
              
              // Wait for transition, then hide container
              if (fadeState.isVisible && !fadeState.hideTimeout) {
                fadeState.hideTimeout = setTimeout(function() {
                  element.style.display = 'none';
                  fadeState.isVisible = false;
                  fadeState.hideTimeout = null;
                }, transitionMs + 50); // Add 50ms buffer
              }
            } else {
              // Instant hide
              element.style.display = 'none';
            }
          } else {
            // In range and bounds
            if (fadeState.hideTimeout) {
              clearTimeout(fadeState.hideTimeout);
              fadeState.hideTimeout = null;
            }
            
            element.style.display = 'block';
            element.style.visibility = 'visible';
            
            if (fadeEnabled && rootUIElement) {
              // Fade in: restore original opacity on root UI element
              rootUIElement.style.opacity = fadeState.originalOpacity.toString();
              fadeState.isVisible = true;
            }
          }
        });
      };
      
      console.log('✅ Spatial UI rendering initialized');
    }

    // Initialize custom logic manager and load logics (AFTER spatial UI so it can reference UI elements)
    if (customLogicData && scene) {
      customLogicManager = new CustomLogicManager(scene);
      await customLogicManager.loadCustomLogics(customLogicData);
      console.log('🧠 Custom logic system initialized');
    }

    // Hide loading overlay
    hideLoading();
    
  } catch (error) {
    showError('Failed to load scene: ' + error.message);
    console.error('Runtime error:', error);
  }

  // FPS Counter Setup
  function setupFpsCounter(engine, scene) {
    fpsCounter = document.getElementById('fpsDisplay');
    if (!fpsCounter) {
      console.warn('FPS display element not found');
      return;
    }
    
    fpsCounter.textContent = 'FPS: --';
    lastFpsUpdate = Date.now();
    
    // Update FPS every second using scene before render
    scene.registerBeforeRender(function() {
      const now = Date.now();
      if (now - lastFpsUpdate > 1000) {
        const fps = Math.round(engine.getFps());
        fpsCounter.textContent = 'FPS: ' + fps;
        
        // Color code based on performance
        if (fps >= 55) {
          fpsCounter.style.color = '#22c55e'; // Green
        } else if (fps >= 30) {
          fpsCounter.style.color = '#f59e0b'; // Orange
        } else {
          fpsCounter.style.color = '#ef4444'; // Red
        }
        
        lastFpsUpdate = now;
      }
    });
    
    console.log('📊 FPS counter enabled');
  }

  // Audio System Setup
  function setupAudioSystem(sceneGraph, scene) {
    const initAudioBtn = document.getElementById('initAudioBtn');
    if (initAudioBtn) {
      initAudioBtn.addEventListener('click', function() {
        initializeAudio(sceneGraph, scene);
      });
      
      // Update button state based on audio nodes
      if (audioNodes.length === 0) {
        initAudioBtn.disabled = true;
        initAudioBtn.textContent = 'No Audio';
      } else {
        initAudioBtn.disabled = false;
        initAudioBtn.textContent = 'Initialize Audio (' + audioNodes.length + ')';
      }
    }
  }

  // Initialize Audio System
  function initializeAudio(sceneGraph, scene) {
    if (audioInitialized) {
      console.log('🔊 Audio already initialized');
      return;
    }

    console.log('🔊 Initializing ' + audioNodes.length + ' audio nodes...');
    
    // Find active controller for spatial audio
    updateActiveController(sceneGraph, scene);
    
    for (const audioNode of audioNodes) {
      if (!audioNode.audioFile || !audioNode.enabled) {
        continue;
      }

      try {
        // Convert storage path to asset path
        const audioUrl = toRelativeAssetPath(audioNode.audioFile);
        console.log('🔊 Loading audio: ' + audioNode.name + ' from ' + audioUrl);
        
        // Create audio element
        const audio = new Audio(audioUrl);
        audio.loop = audioNode.loop;
        audio.volume = audioNode.spatialAudio ? 0 : audioNode.volume; // Start at 0 for spatial audio
        
        // Store reference
        audioNode.audioElement = audio;
        
        // For non-spatial audio, just play it
        if (!audioNode.spatialAudio) {
          audio.play().catch(function(error) {
            console.warn('Failed to play audio ' + audioNode.name + ':', error);
          });
          console.log('🔊 Started non-spatial audio: ' + audioNode.name + ' at volume ' + audio.volume);
        } else {
          // For spatial audio, start playing (volume will be controlled by distance)
          audio.volume = 0; // Start muted, will be updated by spatial system
          audio.play().catch(function(error) {
            console.warn('Failed to play spatial audio ' + audioNode.name + ':', error);
          });
          console.log('🔊 Started spatial audio: ' + audioNode.name + ' (muted, will be controlled by distance)');
        }
        
        console.log('✅ Audio initialized: ' + audioNode.name + ' (spatial: ' + audioNode.spatialAudio + ')');
      } catch (error) {
        console.error('Failed to initialize audio ' + audioNode.name + ':', error);
      }
    }

    // Set up spatial audio update loop
    const spatialAudioNodes = audioNodes.filter(function(node) { 
      return node.spatialAudio && node.audioElement; 
    });
    if (spatialAudioNodes.length > 0) {
      console.log('🔊 Setting up spatial audio for ' + spatialAudioNodes.length + ' nodes');
      setupSpatialAudioUpdate(scene);
    } else {
      console.log('🔊 No spatial audio nodes to set up');
    }

    audioInitialized = true;
    
    // Update button
    const initAudioBtn = document.getElementById('initAudioBtn');
    if (initAudioBtn) {
      initAudioBtn.disabled = true;
      initAudioBtn.textContent = 'Audio Initialized';
    }
    
    console.log('🔊 Audio system initialized successfully');
  }

  // Find Active Controller
  function updateActiveController(sceneGraph, scene) {
    if (sceneGraph && sceneGraph.nodes) {
      const activeControllerNode = sceneGraph.nodes.find(function(node) {
        return node.inputControl && node.inputControl.active && node.inputControl.locomotionType !== 'none' && !(node.metadata && node.metadata.deleted === true);
      });
      
      if (activeControllerNode) {
        const controllerObject = scene.getNodeById(activeControllerNode.id);
        if (controllerObject) {
          activeController = controllerObject;
          console.log('🎮 Active controller found: ' + activeControllerNode.name);
        }
      }
    }
  }

  // Spatial Audio Update Loop
  function setupSpatialAudioUpdate(scene) {
    console.log('🔊 Setting up spatial audio update loop');
    
    let debugCounter = 0;
    
    // Update spatial audio volumes based on distance to active controller
    scene.registerBeforeRender(function() {
      if (!activeController) {
        return;
      }

      const controllerPosition = activeController.position;
      
      for (const audioNode of audioNodes) {
        if (!audioNode.spatialAudio || !audioNode.audioElement || !audioNode.enabled) {
          continue;
        }

        const audioPosition = audioNode.transform.position;
        const distance = BABYLON.Vector3.Distance(controllerPosition, audioPosition);
        
        // Calculate volume based on distance and radius (matching reference implementation)
        const normalizedDistance = distance / audioNode.radius;
        const volume = Math.max(0, audioNode.volume - normalizedDistance);
        
        audioNode.audioElement.volume = volume;
        
        // Debug every 60 frames (roughly once per second at 60fps)
        if (debugCounter % 60 === 0) {
          const isPlaying = !audioNode.audioElement.paused;
          const currentVolume = audioNode.audioElement.volume;
          console.log('🔊 [' + audioNode.name + '] Distance: ' + distance.toFixed(2) + ', Radius: ' + audioNode.radius + ', MaxVol: ' + audioNode.volume + ', CalcVol: ' + volume.toFixed(3) + ', ActualVol: ' + currentVolume.toFixed(3) + ', Playing: ' + isPlaying);
        }
      }
      
      debugCounter++;
    });
  }

  // Instantiate scene graph (adapted from viewer.js)
  async function instantiateGraph(graph, scene) {
    console.log('🏗️ Instantiating scene graph with', graph.nodes.length, 'nodes');
    
    // First pass: Create all non-child-mesh objects (models, lights, cameras, top-level meshes)
    const childMeshNodes = [];
    for (const node of graph.nodes) {
      if (node.kind === 'mesh' && node.id.includes('::mesh::') && node.parentId) {
        // Defer child mesh processing
        childMeshNodes.push(node);
      } else {
        await instantiateNode(node, scene);
      }
    }

    // Second pass: Apply transforms to child meshes (after models are loaded)
    if (childMeshNodes.length > 0) {
      console.log('🎯 Processing', childMeshNodes.length, 'child mesh transforms...');
      for (const node of childMeshNodes) {
        await instantiateNode(node, scene);
      }
    }

    // Third pass: Apply parent relationships for all nodes that have parentId
    // This ensures all objects exist before we try to establish parent-child relationships
    const nodesWithParents = graph.nodes.filter(node => 
      node.parentId && 
      !node.id.includes('::mesh::') // Skip child meshes as they're handled above
    );
    
    if (nodesWithParents.length > 0) {
      console.log('🔗 Applying parent relationships for', nodesWithParents.length, 'nodes...');
      
      for (const node of nodesWithParents) {
        const childObj = scene.getNodeById(node.id);
        const parentObj = scene.getNodeById(node.parentId);
        
        if (childObj && parentObj) {
          console.log('🔗 Applying parent relationship: ' + node.id + ' → ' + node.parentId);
          if (node.kind === 'camera') {
            console.log('📷 Camera parenting enabled: ' + (node.name || node.id) + ' → ' + (parentObj.name || node.parentId));
          }
          console.log('📍 Child transform from scene graph:', node.transform);
          
          // Apply Babylon.js parent relationship
          if (childObj.setParent && typeof childObj.setParent === 'function') {
            childObj.setParent(parentObj);
          } else if ('parent' in childObj) {
            childObj.parent = parentObj;
          }
          
          // CRITICAL: After setting parent, apply the saved LOCAL transform
          // The saved transform should be relative to the parent
          if (node.transform) {
            const localPos = new BABYLON.Vector3(...node.transform.position);
            const localRot = node.transform.rotation ? new BABYLON.Vector3(...node.transform.rotation) : BABYLON.Vector3.Zero();
            const localScale = node.transform.scaling ? new BABYLON.Vector3(...node.transform.scaling) : BABYLON.Vector3.One();
            
            childObj.position = localPos;
            childObj.rotation = localRot;
            childObj.scaling = localScale;
            
            console.log('📍 Applied local transform after parenting:', {
              position: localPos,
              rotation: localRot,
              scaling: localScale
            });
          }
          
          console.log('✅ Applied parent relationship: ' + node.id + ' → ' + node.parentId);
        } else {
          console.warn('⚠️ Could not find objects for parent relationship: ' + node.id + ' → ' + node.parentId);
        }
      }
    }
    
    console.log('✅ Graph instantiation complete');
  }

  async function instantiateNode(node, scene) {
    // Skip instantiation of deleted objects (soft-deleted, in trash bin)
    if (node.metadata && node.metadata.deleted === true) {
      console.log('🗑️ Skipping instantiation of deleted object:', node.name, '(' + node.id + ')');
      return;
    }

    const position = new BABYLON.Vector3(...node.transform.position);
    const rotation = node.transform.rotation ? new BABYLON.Vector3(...node.transform.rotation) : BABYLON.Vector3.Zero();
    const scaling = node.transform.scaling ? new BABYLON.Vector3(...node.transform.scaling) : BABYLON.Vector3.One();

    try {
      switch (node.kind) {
        case 'camera':
          // Create camera based on type stored in scene graph
          let camera;
          const cameraProps = node.camera || { type: 'ArcRotate', minZ: 0.1, maxZ: 100 };
          
          if (cameraProps.type === 'Universal') {
            camera = new BABYLON.UniversalCamera(node.id, position, scene);
            if (rotation) {
              camera.rotation = rotation;
            }
          } else {
            // ArcRotate (default)
            const alpha = cameraProps.alpha || -Math.PI / 2;
            const beta = cameraProps.beta || Math.PI / 2.5;
            const radius = cameraProps.radius || position.length() || 15;
            const target = cameraProps.target ? new BABYLON.Vector3(...cameraProps.target) : BABYLON.Vector3.Zero();
            
            // Handle object targeting (like viewer.js)
            if (cameraProps.targetMode === 'object' && cameraProps.targetObject) {
              // Find the target node in the scene graph
              const targetNode = EXPORTED_SCENE_GRAPH.nodes.find(function(n) { return n.id === cameraProps.targetObject; });
              if (targetNode && targetNode.transform.position) {
                const targetPos = new BABYLON.Vector3(targetNode.transform.position[0], targetNode.transform.position[1], targetNode.transform.position[2]);
                // Apply target offset
                const offset = cameraProps.targetOffset || [0, 0, 0];
                const offsetTargetPos = new BABYLON.Vector3(
                  targetPos.x + offset[0],
                  targetPos.y + offset[1],
                  targetPos.z + offset[2]
                );
                camera = new BABYLON.ArcRotateCamera(node.id, alpha, beta, radius, offsetTargetPos, scene);
                
                // Store reference for potential dynamic updates (critical for tracking)
                camera._targetObjectId = cameraProps.targetObject;
                console.log('📹 Camera created with object target:', node.name, '→', cameraProps.targetObject);
              } else {
                // Fallback to default target if object not found
                camera = new BABYLON.ArcRotateCamera(node.id, alpha, beta, radius, target, scene);
                console.warn('⚠️ Camera target object not found:', cameraProps.targetObject);
              }
            } else {
              camera = new BABYLON.ArcRotateCamera(node.id, alpha, beta, radius, target, scene);
            }
            
            // Set radius limits if specified
            if (cameraProps.lowerRadiusLimit !== undefined) {
              camera.lowerRadiusLimit = cameraProps.lowerRadiusLimit;
            }
            if (cameraProps.upperRadiusLimit !== undefined) {
              camera.upperRadiusLimit = cameraProps.upperRadiusLimit;
            }
            
            // Set zoom sensitivity with dynamic behavior (wheelDeltaPercentage)
            const wheelDelta = cameraProps.wheelDeltaPercentage !== undefined ? cameraProps.wheelDeltaPercentage : 0.01;
            setupUserCameraDynamicZoom(camera, wheelDelta);
            console.log('🎯 Set camera zoom sensitivity with dynamic behavior:', node.name, 'to:', wheelDelta);
          }
          
          // Set common camera properties (use exact values from editor)
          camera.minZ = typeof cameraProps.minZ === 'number' ? cameraProps.minZ : 0.01;
          camera.maxZ = typeof cameraProps.maxZ === 'number' ? cameraProps.maxZ : 100;
          camera.fov = cameraProps.fov || Math.PI / 4;
          
          // Apply enabled state
          const cameraEnabled = node.enabled !== false;
          camera.setEnabled(cameraEnabled);
          
          // Set as active camera if marked as such (and attach controls)
          if (cameraProps.active) {
            scene.activeCamera = camera;
            camera.attachControl(canvas, true);
          }
          
          break;

        case 'light': {
          // Create light based on saved type and properties
          let light;
          const lightProps = node.light || { type: 'Hemispheric', intensity: 0.7, color: [1, 1, 1], enabled: true };

          switch (lightProps.type) {
            case 'Point': {
              light = new BABYLON.PointLight(node.id, position, scene);
              if (lightProps.range !== undefined) {
                light.range = lightProps.range;
              }
              break;
            }
            case 'Spot': {
              // Compute direction from node rotation
              let direction = new BABYLON.Vector3(0, -1, 0);
              if (node.transform.rotation) {
                // Use downward vector (0, -1, 0) as base direction to match default light direction
                const baseDirection = new BABYLON.Vector3(0, -1, 0);
                direction = baseDirection.rotateByQuaternionToRef(
                  BABYLON.Quaternion.FromEulerAngles(
                    node.transform.rotation[0],
                    node.transform.rotation[1],
                    node.transform.rotation[2]
                  ),
                  new BABYLON.Vector3()
                );
              }
              light = new BABYLON.SpotLight(
                node.id,
                position,
                direction,
                lightProps.angle || Math.PI / 6,
                lightProps.exponent || 1,
                scene
              );
              if (lightProps.range !== undefined) {
                light.range = lightProps.range;
              }
              break;
            }
            case 'Directional': {
              // Compute direction from node rotation
              let direction = new BABYLON.Vector3(0, -1, 0);
              if (node.transform.rotation) {
                // Use downward vector (0, -1, 0) as base direction to match default light direction
                const baseDirection = new BABYLON.Vector3(0, -1, 0);
                direction = baseDirection.rotateByQuaternionToRef(
                  BABYLON.Quaternion.FromEulerAngles(
                    node.transform.rotation[0],
                    node.transform.rotation[1],
                    node.transform.rotation[2]
                  ),
                  new BABYLON.Vector3()
                );
              }
              light = new BABYLON.DirectionalLight(node.id, direction, scene);
              // Position directional for better shadow casting
              light.position = position;
              break;
            }
            case 'Hemispheric':
            default: {
              const direction = new BABYLON.Vector3(0, 1, 0);
              light = new BABYLON.HemisphericLight(node.id, direction, scene);
              if (lightProps.groundColor) {
                light.groundColor = new BABYLON.Color3(...lightProps.groundColor);
              }
              break;
            }
          }

          // Common light properties
          if (typeof lightProps.intensity === 'number') {
            light.intensity = lightProps.intensity;
          } else {
            light.intensity = 0.7;
          }
          if (Array.isArray(lightProps.color) && lightProps.color.length === 3) {
            light.diffuse = new BABYLON.Color3(...lightProps.color);
          }

          // Apply enabled state from node
          const lightEnabled = node.enabled !== false;
          light.setEnabled(lightEnabled);
          break;
        }

        case 'mesh':
          let mesh = null;
          
          // Check if this is a child mesh (contains ::mesh::)
          if (node.id.includes('::mesh::') && node.parentId) {
            // Child mesh - find by stableId (with legacy numeric fallback)
            const token = getChildTokenFromId(node.id);
            if (token) {
              // Primary: find by stableId
              mesh = scene.meshes.find(m => m.metadata && m.metadata.stableId === token);

              // Legacy fallback: numeric uniqueId
              if (!mesh && /^[0-9]+$/.test(token)) {
                const uniq = parseInt(token, 10);
                mesh = scene.meshes.find(m => m.uniqueId === uniq);
              }

              if (mesh) {
                // Apply child mesh transform
                mesh.position = position;
                if (mesh.rotationQuaternion) {
                  mesh.rotationQuaternion = BABYLON.Quaternion.FromEulerAngles(rotation.x, rotation.y, rotation.z);
                } else {
                  mesh.rotation = rotation;
                }
                mesh.scaling = scaling;
                
                // Apply physics if object has physics properties
                if (node.physics && node.physics.enabled && scene.getPhysicsEngine()) {
                  console.log('🔷 Applying physics to child mesh:', node.physics.type, node.physics.impostor);
                  applyPhysicsToObject(mesh, node.physics, scene, node);
                }
              } else {
                console.warn('⚠️ RUNTIME: Child mesh not found (stableId/legacy):', node.id);
              }
            }
          } else if (node.id === 'defaultCube') {
            mesh = BABYLON.MeshBuilder.CreateBox(node.id, { size: 2 }, scene);
            mesh.position = position;
            mesh.rotation = rotation;
            mesh.scaling = scaling;
            
            // Create PBR material for better IBL visualization
            const cubeMaterial = new BABYLON.PBRMaterial('defaultCubeMaterial', scene);
            cubeMaterial.albedoColor = new BABYLON.Color3(0.8, 0.8, 0.8);
            cubeMaterial.metallic = 0.1;
            cubeMaterial.roughness = 0.3;
            mesh.material = cubeMaterial;
            
            // Apply physics if object has physics properties
            if (node.physics && node.physics.enabled && scene.getPhysicsEngine()) {
              console.log('🔷 Applying physics to cube:', node.physics.type, node.physics.impostor);
              applyPhysicsToObject(mesh, node.physics, scene, node);
            }
          } else if (node.id === 'ground') {
            mesh = BABYLON.MeshBuilder.CreateGround(node.id, { width: 6, height: 6 }, scene);
            mesh.position = position;
            mesh.rotation = rotation;
            mesh.scaling = scaling;
            
            // Create PBR material for better IBL visualization
            const groundMaterial = new BABYLON.PBRMaterial('groundMaterial', scene);
            groundMaterial.albedoColor = new BABYLON.Color3(0.5, 0.5, 0.5);
            groundMaterial.metallic = 0.0;
            groundMaterial.roughness = 0.8;
            mesh.material = groundMaterial;
            
            // Apply physics if object has physics properties
            if (node.physics && node.physics.enabled && scene.getPhysicsEngine()) {
              console.log('🔷 Applying physics to ground:', node.physics.type, node.physics.impostor);
              applyPhysicsToObject(mesh, node.physics, scene, node);
            }
          } else if (node.metadata && node.metadata.primitiveType) {
            // Handle primitive meshes created by addPrimitiveMesh
            const primitiveType = node.metadata.primitiveType;
            
            switch (primitiveType) {
              case 'plane':
                mesh = BABYLON.MeshBuilder.CreatePlane(node.id, { size: 2 }, scene);
                break;
              case 'cube':
                mesh = BABYLON.MeshBuilder.CreateBox(node.id, { size: 2 }, scene);
                break;
              case 'sphere':
                mesh = BABYLON.MeshBuilder.CreateSphere(node.id, { diameter: 2 }, scene);
                break;
              case 'cylinder':
                mesh = BABYLON.MeshBuilder.CreateCylinder(node.id, { height: 2, diameter: 2 }, scene);
                break;
              case 'cone':
                mesh = BABYLON.MeshBuilder.CreateCylinder(node.id, { height: 2, diameterTop: 0, diameterBottom: 2 }, scene);
                break;
              default:
                console.warn('⚠️ Unknown primitive type:', primitiveType);
                break;
            }
            
            if (mesh) {
              mesh.position = position;
              mesh.rotation = rotation;
              mesh.scaling = scaling;
              
              // Create default PBR material (same as runtime)
              const material = new BABYLON.PBRMaterial(node.id + '_material', scene);
              material.albedoColor = new BABYLON.Color3(0.8, 0.8, 0.8);
              material.metallic = 0.1;
              material.roughness = 0.5;
              mesh.material = material;
              
              console.log('✅ Created ' + primitiveType + ' primitive in runtime:', node.id);
              
              // Apply physics if object has physics properties
              if (node.physics && node.physics.enabled && scene.getPhysicsEngine()) {
                console.log('🔷 Applying physics to ' + primitiveType + ':', node.physics.type, node.physics.impostor);
                applyPhysicsToObject(mesh, node.physics, scene, node);
              }
            }
          }
          
          // Apply visibility and enabled states
          if (mesh) {
            const visible = node.visible !== false;
            const enabled = node.enabled !== false;
            // For meshes, both visible and enabled use the visibility property
            mesh.visibility = (visible && enabled) ? 1 : 0;
          }
          break;

        case 'model':
          if (node.src) {
            await loadModelFromAssets(node, scene);
            
            // Apply physics if object has physics properties
            if (node.physics && node.physics.enabled && scene.getPhysicsEngine()) {
              console.log('🔷 Applying physics to model ' + node.name + ':', node.physics.type, node.physics.impostor);
              const rootMesh = scene.getNodeById(node.id);
              if (rootMesh) {
                applyPhysicsToObject(rootMesh, node.physics, scene, node);
              }
            }
          }
          break;

        case 'particle':
          console.log('🌟 Creating particle system: ' + node.name);
          await createParticleSystem(node, scene);
          break;

        case 'audio':
          console.log('🔊 Creating audio node: ' + node.name);
          const audioProps = node.audio || {};
          
          // Create a transform node to represent the audio position
          const audioTransform = new BABYLON.TransformNode(node.id, scene);
          audioTransform.position = position;
          audioTransform.rotation = rotation;
          audioTransform.scaling = scaling;
          
          // Apply visibility and enabled states
          const visible = node.visible !== false;
          const enabled = node.enabled !== false;
          audioTransform.setEnabled(enabled && visible);
          
          // Store audio data for later initialization (browser requires user interaction)
          audioNodes.push({
            id: node.id,
            name: node.name,
            transform: audioTransform,
            audioFile: audioProps.audioFile,
            volume: audioProps.volume !== undefined ? audioProps.volume : 1.0,
            loop: audioProps.loop !== undefined ? audioProps.loop : false,
            spatialAudio: audioProps.spatialAudio !== undefined ? audioProps.spatialAudio : false,
            radius: audioProps.radius !== undefined ? audioProps.radius : 10,
            enabled: enabled && visible,
            audioElement: null // Will be created on initialization
          });
          
          console.log('✅ Created audio node: ' + node.id + ' (' + (audioProps.audioFile || 'no file') + ')');
          break;
        
        case 'spatialui':
          console.log('🎨 Creating spatial UI node: ' + node.name);
          const spatialUIProps = node.spatialUI || {};
          
          // Create a transform node to represent the spatial UI position
          const spatialUITransform = new BABYLON.TransformNode(node.id, scene);
          spatialUITransform.position = position;
          spatialUITransform.rotation = rotation;
          spatialUITransform.scaling = scaling;
          
          // Apply visibility and enabled states
          const spatialUIVisible = node.visible !== false;
          const spatialUIEnabled = node.enabled !== false;
          spatialUITransform.setEnabled(spatialUIEnabled && spatialUIVisible);
          
          // Spatial UI rendering is handled by updateSpatialUI function which directly reads from scene graph
          console.log('✅ Created spatial UI node: ' + node.id + ' (UI element: ' + spatialUIProps.uiElementId + ')');
          break;
      }
    } catch (error) {
      console.error('Failed to instantiate node ' + node.id + ':', error);
    }
  }

  async function loadModelFromAssets(node, scene) {
    if (!scene || !node.src) return;

    try {
      // Convert storage path to asset path
      const rel = toRelativeAssetPath(node.src);
      // Use the path as-is (toRelativeAssetPath already handles directory structure correctly)
      const assetPath = rel;
      console.log('🔗 Loading model from:', assetPath);
      
      // URL encode the path to handle spaces and special characters
      const encodedAssetPath = assetPath.split('/').map(function(part) {
        return encodeURIComponent(part);
      }).join('/');
      console.log('🔗 Encoded path:', encodedAssetPath);
      
      // Load the asset container with proper rootUrl/filename for GLTF so sidecars resolve correctly
      let result = null;
      const lower = assetPath.toLowerCase();
      if (lower.endsWith('.gltf')) {
        const lastSlash = encodedAssetPath.lastIndexOf('/');
        const rootUrl = encodedAssetPath.substring(0, lastSlash + 1);
        const filename = encodedAssetPath.substring(lastSlash + 1);
        console.log('🔗 GLTF Root URL:', rootUrl);
        console.log('🔗 GLTF Filename:', filename);
        result = await BABYLON.SceneLoader.LoadAssetContainerAsync(rootUrl, filename, scene);
      } else {
        result = await BABYLON.SceneLoader.LoadAssetContainerAsync('', encodedAssetPath, scene);
      }
      
      if (result.meshes.length > 0) {
        // Create a parent transform node
        const parentNode = new BABYLON.TransformNode(node.id, scene);
        parentNode.position = new BABYLON.Vector3(...node.transform.position);
        
        if (node.transform.rotation) {
          parentNode.rotation = new BABYLON.Vector3(...node.transform.rotation);
        }
        if (node.transform.scaling) {
          parentNode.scaling = new BABYLON.Vector3(...node.transform.scaling);
        }

        // Parent all loaded meshes to the transform node
        result.meshes.forEach(mesh => {
          mesh.parent = parentNode;
        });

        // Apply visibility and enabled states with proper inheritance
        const parentVisible = node.visible !== false;
        const parentEnabled = node.enabled !== false;
        
        // PATCH: assign stableId to runtime meshes from SceneGraph children, then apply states
        const MESH_TAG = '::mesh::';
        function getChildTokenFromId(id) {
          const i = id.lastIndexOf(MESH_TAG);
          return i >= 0 ? id.slice(i + MESH_TAG.length) : null;
        }

        // 1) Gather SceneGraph child nodes of this model
        const childNodes = (EXPORTED_SCENE_GRAPH?.nodes || []).filter(n => n.parentId === node.id && n.kind === 'mesh');

        // 2) Build a deterministic map of (name, occurrenceIndex) -> { node, token }
        const sgIndex = new Map();
        {
          const nameCounts = new Map(); // lowercased name -> next index
          for (const cn of childNodes) {
            const nm = (cn.name || 'Mesh').toLowerCase();
            const idx = nameCounts.get(nm) || 0;
            nameCounts.set(nm, idx + 1);

            const token = getChildTokenFromId(cn.id) || '';
            const key = `${nm}::${idx}`;
            sgIndex.set(key, { node: cn, token });
          }
        }

        // 3) Walk runtime meshes in the same deterministic fashion
        {
          const nameCounts = new Map();
          const meshesToKeep = [];
          
          // Filter out __root__ wrapper mesh (Babylon's container mesh)
          const actualMeshes = result.meshes
            .filter(m => m instanceof BABYLON.Mesh)
            .filter(m => m.name !== "__root__");
          
          for (const mesh of actualMeshes) {
            if (!mesh.metadata) mesh.metadata = {};
            const nm = (mesh.name || 'Mesh').toLowerCase();
            const idx = nameCounts.get(nm) || 0;
            nameCounts.set(nm, idx + 1);

            const key = `${nm}::${idx}`;
            const entry = sgIndex.get(key);

            if (entry) {
              const { node: childNode, token } = entry;

              // Assign runtime stableId from graph token
              mesh.metadata.stableId = token;

              // Apply visibility/enabled with parent inheritance
              const childVisible = childNode.visible !== false;
              const childEnabled = childNode.enabled !== false;
              const effectiveVisible = childVisible && childEnabled && parentVisible && parentEnabled;

              mesh.visibility = effectiveVisible ? 1 : 0;
              meshesToKeep.push(mesh);
            } else {
              // No saved child node — this mesh was deleted, so dispose it
              console.log('🗑️ RUNTIME: Skipping deleted child mesh:', mesh.name);
              mesh.dispose();
            }
          }
          
          // Replace the meshes array with only the ones we want to keep
          result.meshes = meshesToKeep;
        }

        // Add to scene
        result.addAllToScene();

        // Start animation groups after adding to scene
        if (result.animationGroups && result.animationGroups.length > 0) {
          console.log(`🎬 Starting ${result.animationGroups.length} animation groups for ${node.name}`);
          result.animationGroups.forEach(animGroup => {
            animGroup.start(true, 1.0, animGroup.from, animGroup.to, false);
          });
          console.log('✅ Animation groups started');
        }
        
        console.log('✅ Model loaded successfully:', node.name);
      }
    } catch (error) {
      console.error('❌ Failed to load model ' + node.name + ':', error);
    }
  }

  // Create a particle system from node configuration
  async function createParticleSystem(node, scene) {
    if (!scene || !node.particle) {
      console.warn('⚠️ Cannot create particle system: missing scene or particle config');
      return;
    }

    const config = node.particle;
    const position = new BABYLON.Vector3(...node.transform.position);
    const rotation = node.transform.rotation ? new BABYLON.Vector3(...node.transform.rotation) : BABYLON.Vector3.Zero();
    const scaling = node.transform.scaling ? new BABYLON.Vector3(...node.transform.scaling) : BABYLON.Vector3.One();

    try {
      // Create emitter transform node
      const emitter = new BABYLON.TransformNode(node.id, scene);
      emitter.position = position;
      emitter.rotation = rotation;
      emitter.scaling = scaling;

      // Only handle ParticleSystem runtime in app.js for now
      if (config.runtime === 'ParticleSystem') {
        console.log('🌟 Creating Babylon.js ParticleSystem for:', node.name);
        
        // Create particle system
        const particleSystem = new BABYLON.ParticleSystem(node.id + '_particles', config.capacity || 2000, scene);

        // Basic properties
        particleSystem.emitRate = config.emitRate || 10;
        particleSystem.minEmitPower = config.minEmitPower || 1;
        particleSystem.maxEmitPower = config.maxEmitPower || 3;
        particleSystem.minSize = config.minSize || 1;
        particleSystem.maxSize = config.maxSize || 1;
        particleSystem.minLifeTime = config.minLifeTime || 1;
        particleSystem.maxLifeTime = config.maxLifeTime || 1.5;
        particleSystem.minAngularSpeed = config.minAngularSpeed || 0;
        particleSystem.maxAngularSpeed = config.maxAngularSpeed || Math.PI;
        particleSystem.updateSpeed = config.updateSpeed || 0.005;

        // Gravity and directions
        if (config.gravity) {
          particleSystem.gravity = new BABYLON.Vector3(config.gravity[0], config.gravity[1], config.gravity[2]);
        }
        if (config.direction1) {
          particleSystem.direction1 = new BABYLON.Vector3(config.direction1[0], config.direction1[1], config.direction1[2]);
        }
        if (config.direction2) {
          particleSystem.direction2 = new BABYLON.Vector3(config.direction2[0], config.direction2[1], config.direction2[2]);
        }

        // Billboard mode
        switch (config.billboardMode) {
          case 'ALL':
            particleSystem.billboardMode = BABYLON.ParticleSystem.BILLBOARDMODE_ALL;
            break;
          case 'Y':
            particleSystem.billboardMode = BABYLON.ParticleSystem.BILLBOARDMODE_Y;
            break;
          case 'NONE':
            particleSystem.billboardMode = BABYLON.ParticleSystem.BILLBOARDMODE_Y; // Fallback
            break;
          default:
            particleSystem.billboardMode = BABYLON.ParticleSystem.BILLBOARDMODE_ALL;
        }

        // Blend mode
        switch (config.blendMode) {
          case 'ADD':
            particleSystem.blendMode = BABYLON.ParticleSystem.BLENDMODE_ADD;
            break;
          case 'STANDARD':
          default:
            particleSystem.blendMode = BABYLON.ParticleSystem.BLENDMODE_STANDARD;
            break;
        }

        // Load texture
        if (config.textureUrl) {
          try {
            if (config.textureUrl.startsWith('embedded:')) {
              console.warn('⚠️ Embedded textures not supported in runtime yet');
              createDefaultParticleTexture(particleSystem, scene);
            } else {
              const texture = loadTextureFromAssetPath(config.textureUrl, scene);
              if (texture) {
                particleSystem.particleTexture = texture;
                console.log('🖼️ Applied texture to particle system:', config.textureUrl);
              } else {
                createDefaultParticleTexture(particleSystem, scene);
              }
            }
          } catch (error) {
            console.warn('Failed to load particle texture:', config.textureUrl, error);
            createDefaultParticleTexture(particleSystem, scene);
          }
        } else {
          createDefaultParticleTexture(particleSystem, scene);
        }

        // Color gradients
        if (config.enableColorGradients && config.colorGradients && config.colorGradients.length > 0) {
          config.colorGradients.forEach(function(grad) {
            particleSystem.addColorGradient(
              grad.t,
              new BABYLON.Color4(grad.r, grad.g, grad.b, grad.a)
            );
          });
        } else {
          // Default colors
          particleSystem.color1 = new BABYLON.Color4(1, 1, 1, 0.8);
          particleSystem.color2 = new BABYLON.Color4(0.8, 0.8, 1, 0.6);
          particleSystem.colorDead = new BABYLON.Color4(0.6, 0.6, 0.9, 0);
        }

        // Apply emitter settings
        applyEmitterSettings(particleSystem, config.emitter, emitter);

        // Start if configured
        if (config.playOnStart !== false) { // default to true
          particleSystem.start();
        }

        console.log('✅ Particle system created successfully:', node.name);
      } else {
        console.warn('⚠️ SolidParticleSystem not supported in runtime yet');
      }
    } catch (error) {
      console.error('❌ Failed to create particle system:', error);
    }
  }

  // Create default white circle texture for particles
  function createDefaultParticleTexture(particleSystem, scene) {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 64;
      const ctx = canvas.getContext('2d');
      
      // Create white circle with soft edges
      const gradient = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
      gradient.addColorStop(0, 'rgba(255, 255, 255, 1)');
      gradient.addColorStop(0.7, 'rgba(255, 255, 255, 0.8)');
      gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
      
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, 64, 64);
      
      const texture = new BABYLON.Texture('data:' + canvas.toDataURL(), scene);
      texture.name = 'defaultParticleTexture';
      particleSystem.particleTexture = texture;
      
      console.log('✅ Created default white circle texture for particles');
    } catch (error) {
      console.warn('Failed to create default particle texture:', error);
    }
  }

  // Apply emitter settings to particle system
  function applyEmitterSettings(particleSystem, emitter, emitterNode) {
    if (!emitter) {
      emitter = { kind: 'point' };
    }

    // Set emitter position
    particleSystem.emitter = emitterNode.position;

    switch (emitter.kind) {
      case 'point':
        particleSystem.minEmitBox = new BABYLON.Vector3(0, 0, 0);
        particleSystem.maxEmitBox = new BABYLON.Vector3(0, 0, 0);
        break;
        
      case 'box':
        if (emitter.min && emitter.max) {
          particleSystem.minEmitBox = new BABYLON.Vector3(emitter.min[0], emitter.min[1], emitter.min[2]);
          particleSystem.maxEmitBox = new BABYLON.Vector3(emitter.max[0], emitter.max[1], emitter.max[2]);
        }
        break;
        
      case 'sphere':
        if (typeof emitter.radius === 'number') {
          particleSystem.createSphereEmitter(emitter.radius, emitter.radiusRange || 0);
        }
        break;
        
      case 'cone':
        if (typeof emitter.radius === 'number') {
          particleSystem.createConeEmitter(emitter.radius, emitter.angle || 45);
        }
        break;
        
      default:
        // Default to point emitter
        particleSystem.minEmitBox = new BABYLON.Vector3(0, 0, 0);
        particleSystem.maxEmitBox = new BABYLON.Vector3(0, 0, 0);
        break;
    }
  }

  // Fix IBL material reflections - this is what skybox creation accidentally does right!
  function refreshMaterialsForIBL(scene) {
    console.log('🔧 Applying proper IBL material refresh (fixes reflection issues)');
    scene.materials.forEach(material => {
      console.log('🔍 Material type:', material.constructor.name, 'name:', material.name);
      if (material instanceof BABYLON.PBRMaterial || material instanceof BABYLON.StandardMaterial) {
        // Clear any incorrectly applied environment textures on the material
        if (material.environmentTexture === scene.environmentTexture) {
          material.environmentTexture = null;
          console.log('🧹 Cleared incorrectly applied environment texture from:', material.name);
        }
        if (material instanceof BABYLON.PBRMaterial && material.albedoTexture === scene.environmentTexture) {
          material.albedoTexture = null;
          console.log('🧹 Cleared environment texture from albedo:', material.name);
        }
        
        material.markDirty();
        console.log('✅ Fixed IBL reflections for material:', material.name);
      } else {
        console.log('❌ Material type not supported for IBL:', material.constructor.name, material.name);
      }
    });
    console.log('🎉 IBL reflections fixed for all materials!');
  }

  // Apply scene settings to the live scene
  async function applySceneSettings(scene, settings) {
    console.log('🎨 Applying scene settings:', settings);
    
    // Environment settings
    const env = settings.environment;
    if (env) {
      // Clear color
      if (env.clearColor) {
        const [r, g, b, a] = env.clearColor;
        scene.clearColor.set(r, g, b, a);
      }
      
      // Ambient color
      if (env.ambientColor) {
        const [r, g, b] = env.ambientColor;
        scene.ambientColor.set(r, g, b);
      }
      
      // IBL (Image-Based Lighting) - AFFECTS SCENE LIGHTING & REFLECTIONS
      console.log('💡 IBL Settings (scene lighting/reflections):', { useIBL: env.useIBL, iblPath: env.iblPath, iblIntensity: env.iblIntensity });
      scene.environmentIntensity = env.iblIntensity || 1;
      
      if (env.useIBL && env.iblPath) {
        try {
          const assetPath = toRelativeAssetPath(env.iblPath);
          console.log('🌍 Loading IBL for SCENE LIGHTING from asset path:', assetPath);
          
          let environmentTexture = null;
          if (assetPath.toLowerCase().endsWith('.env')) {
            console.log('📦 Loading .env IBL texture for scene lighting...');
            environmentTexture = BABYLON.CubeTexture.CreateFromPrefilteredData(assetPath, scene);
          } else {
            console.log('📦 Loading .hdr IBL texture for scene lighting...');
            environmentTexture = new BABYLON.HDRCubeTexture(assetPath, scene, 128, false, true, false, true);
          }
          
          if (environmentTexture) {
            // CRITICAL: This applies IBL to scene lighting and material reflections
            scene.environmentTexture = environmentTexture;
            
            // Apply IBL rotation
            if (typeof env.iblRotation === 'number') {
              const rotationRadians = env.iblRotation * Math.PI / 180;
              environmentTexture.setReflectionTextureMatrix(BABYLON.Matrix.RotationY(rotationRadians));
              console.log('🔄 Applied IBL rotation:', env.iblRotation, 'degrees');
            }
            
            // Set intensity immediately
            scene.environmentIntensity = env.iblIntensity || 1;
            
            // Wait for texture to load and then refresh materials
            environmentTexture.onLoadObservable.addOnce(() => {
              // Set intensity again after texture loads (in case it was reset)
              scene.environmentIntensity = env.iblIntensity || 1;
              console.log('✅ IBL SCENE LIGHTING loaded, intensity set to:', env.iblIntensity);
              
              // Force material refresh for existing materials - critical for IBL LIGHTING to show up
              refreshMaterialsForIBL(scene);
              console.log('✅ IBL SCENE LIGHTING fully loaded, materials refreshed, intensity:', env.iblIntensity);
            });
            
            console.log('✅ IBL SCENE LIGHTING assigned, intensity:', env.iblIntensity);
          }
        } catch (error) {
          console.error('❌ Failed to load IBL texture for scene lighting:', error);
        }
      } else {
        scene.environmentTexture = null;
        console.log('🔄 IBL disabled - cleared scene environment lighting');
      }
      
      // Fog settings
      const fm = env.fogMode;
      scene.fogMode = 
        fm === 'linear' ? BABYLON.Scene.FOGMODE_LINEAR :
        fm === 'exp'    ? BABYLON.Scene.FOGMODE_EXP    :
        fm === 'exp2'   ? BABYLON.Scene.FOGMODE_EXP2   :
                          BABYLON.Scene.FOGMODE_NONE;
    }
    
    // Image processing settings
    const ip = settings.imageProcessing;
    if (ip && scene.imageProcessingConfiguration) {
      const ipc = scene.imageProcessingConfiguration;
      
      ipc.contrast = ip.contrast || 1;
      ipc.exposure = ip.exposure || 1;
      ipc.toneMappingEnabled = !!ip.toneMappingEnabled;
      
      // Tone mapping type
      ipc.toneMappingType = 
        ip.toneMappingType === 'aces'    ? BABYLON.ImageProcessingConfiguration.TONEMAPPING_ACES :
        ip.toneMappingType === 'neutral' ? BABYLON.ImageProcessingConfiguration.TONEMAPPING_ACES : // fallback
                                           BABYLON.ImageProcessingConfiguration.TONEMAPPING_STANDARD;
      
      // Vignette settings
      ipc.vignetteEnabled = !!ip.vignetteEnabled;
      if (ip.vignetteEnabled) {
        ipc.vignetteWeight = ip.vignetteWeight || 1;
        ipc.vignetteStretch = ip.vignetteStretch || 0;
        ipc.vignetteCameraFov = ip.vignetteFov || 1.5;
        
        if (ip.vignetteColor) {
          const [r, g, b, a] = ip.vignetteColor;
          ipc.vignetteColor = new BABYLON.Color4(r, g, b, a);
        }
      }
      
      // Dithering settings
      ipc.ditheringEnabled = !!ip.ditheringEnabled;
      if ('ditheringIntensity' in ipc) {
        ipc.ditheringIntensity = ip.ditheringIntensity || 0.5;
      }
      
      // Highlight Layer
      if (typeof ip.highlightEnabled === 'boolean') {
        if (ip.highlightEnabled) {
          if (!scene.highlightLayer) {
            scene.highlightLayer = new BABYLON.HighlightLayer('highlightLayer', scene);
          }
          const hl = scene.highlightLayer;
          if (typeof ip.highlightBlurHorizontalSize === 'number') {
            hl.blurHorizontalSize = ip.highlightBlurHorizontalSize;
          }
          if (typeof ip.highlightBlurVerticalSize === 'number') {
            hl.blurVerticalSize = ip.highlightBlurVerticalSize;
          }
          hl.innerGlow = false;
          hl.outerGlow = true;
          console.log('✅ Highlight layer enabled');
        } else if (scene.highlightLayer) {
          scene.highlightLayer.dispose();
          scene.highlightLayer = null;
          console.log('🔄 Highlight layer disabled');
        }
      }

      // Glow Layer - Only glows meshes with emissive materials
      if (typeof ip.glowEnabled === 'boolean') {
        if (ip.glowEnabled) {
          if (!scene.glowLayer) {
            scene.glowLayer = new BABYLON.GlowLayer('glowLayer', scene);
          }
          const gl = scene.glowLayer;
          if (typeof ip.glowIntensity === 'number') {
            gl.intensity = ip.glowIntensity;
          }
          if (typeof ip.glowBlurKernelSize === 'number') {
            gl.blurKernelSize = ip.glowBlurKernelSize;
          }
          // Don't override emissive colors - let materials control their own emissive
          console.log('✅ Glow layer enabled with intensity:', ip.glowIntensity);
        } else if (scene.glowLayer) {
          scene.glowLayer.dispose();
          scene.glowLayer = null;
          console.log('🔄 Glow layer disabled');
        }
      }
    }

    // SKYBOX - VISUAL BACKDROP ONLY (NO LIGHTING/REFLECTION EFFECTS)
    if (env && env.useSkybox) {
      console.log('🎭 Creating/Updating VISUAL skybox (backdrop only, no lighting effects)...');
      try {
        // Create or fetch skybox cube - VISUAL BACKDROP ONLY
        let skybox = scene.getMeshByID('__skybox__');
        if (!skybox) {
          skybox = BABYLON.MeshBuilder.CreateBox('skybox', { size: 1000 }, scene);
          skybox.id = '__skybox__';
          skybox.infiniteDistance = true;
          skybox.isPickable = false;
        }

        // Always use StandardMaterial for consistent behavior
        let skyboxMaterial = skybox.material;
        if (!(skyboxMaterial instanceof BABYLON.StandardMaterial)) {
          if (skyboxMaterial) skyboxMaterial.dispose();
          skyboxMaterial = new BABYLON.StandardMaterial('skyboxMaterial', scene);
        }
        skyboxMaterial.disableLighting = true; // No lighting effects
        skyboxMaterial.diffuseColor = new BABYLON.Color3(0, 0, 0);
        skyboxMaterial.specularColor = new BABYLON.Color3(0, 0, 0);
        skyboxMaterial.backFaceCulling = false; // critical: render inside faces

        // Determine skybox texture mode
        const sbType = env.skyboxType || (env.skyboxPanoramaPath ? 'panoramic' : (env.skyboxTextures ? 'cube' : (env.useIBL ? 'iblFallback' : 'none')));

        // Reset any previous textures
        if (skyboxMaterial.reflectionTexture) { skyboxMaterial.reflectionTexture.dispose(); }
        skyboxMaterial.reflectionTexture = null;
        if (skyboxMaterial.diffuseTexture) { skyboxMaterial.diffuseTexture.dispose(); }
        skyboxMaterial.diffuseTexture = null;

        if (sbType === 'panoramic' && env.skyboxPanoramaPath) {
          const panoPath = toRelativeAssetPath(env.skyboxPanoramaPath);
          console.log('🌄 Applying panoramic skybox:', panoPath);
          const tex = new BABYLON.Texture(panoPath, scene, false, true, BABYLON.Texture.TRILINEAR_SAMPLINGMODE);
          tex.coordinatesMode = BABYLON.Texture.FIXED_EQUIRECTANGULAR_MODE;
          
          // Apply skybox rotation
          if (typeof env.skyboxRotation === 'number') {
            const rotationRadians = env.skyboxRotation * Math.PI / 180;
            tex.setReflectionTextureMatrix(BABYLON.Matrix.RotationY(rotationRadians));
            console.log('🔄 Applied skybox rotation:', env.skyboxRotation, 'degrees');
          }
          
          skyboxMaterial.reflectionTexture = tex;
          skybox.isVisible = true;
        } else if (sbType === 'cube' && env.skyboxTextures) {
          const faces = env.skyboxTextures;
          const order = ['px','nx','py','ny','pz','nz'];
          if (order.every(f => faces[f])) {
            const urls = order.map(f => toRelativeAssetPath(faces[f]));
            console.log('🧊 Applying cube skybox with faces:', urls);
            const cube = BABYLON.CubeTexture.CreateFromImages(urls, scene);
            cube.coordinatesMode = BABYLON.Texture.SKYBOX_MODE;
            
            // Apply skybox rotation
            if (typeof env.skyboxRotation === 'number') {
              const rotationRadians = env.skyboxRotation * Math.PI / 180;
              cube.setReflectionTextureMatrix(BABYLON.Matrix.RotationY(rotationRadians));
              console.log('🔄 Applied skybox rotation:', env.skyboxRotation, 'degrees');
            }
            
            skyboxMaterial.reflectionTexture = cube;
            skybox.isVisible = true;
          } else {
            console.warn('⚠️ Cube skybox incomplete; required px,nx,py,ny,pz,nz');
            // Fallback to IBL if available
            if (scene.environmentTexture) {
              skyboxMaterial.reflectionTexture = scene.environmentTexture;
              skyboxMaterial.reflectionTexture.coordinatesMode = BABYLON.Texture.SKYBOX_MODE;
              skybox.isVisible = true;
            } else {
              skybox.isVisible = false;
            }
          }
        } else if (sbType === 'iblFallback' && scene.environmentTexture) {
          console.log('🎭 Skybox fallback to IBL visual texture');
          skyboxMaterial.reflectionTexture = scene.environmentTexture;
          skyboxMaterial.reflectionTexture.coordinatesMode = BABYLON.Texture.SKYBOX_MODE;
          skybox.isVisible = true;
        } else {
          console.log('⚠️ Skybox type set but no texture paths provided');
          skybox.isVisible = false;
        }

        skybox.material = skyboxMaterial;
        console.log('🌌 Skybox visibility:', skybox.isVisible, 'has reflectionTexture:', !!skyboxMaterial.reflectionTexture);
      } catch (error) {
        console.error('❌ Failed to create/update visual skybox:', error);
      }
    } else {
      // Remove visual skybox if disabled
      const existingSkybox = scene.getMeshByID('__skybox__');
      if (existingSkybox) {
        existingSkybox.dispose();
        console.log('🎭 Visual skybox removed');
      }
    }
    
    console.log('✅ Scene settings applied');
  }

    // Apply material property overrides
    function applyMaterialOverrides(scene, overrides) {
    console.log('🎨 RUNTIME: Applying material overrides:', overrides);
    console.log('🔍 RUNTIME: Available materials:', scene.materials.map(m => ({ name: m.name, uniqueId: m.uniqueId })));
    
    for (const [materialName, properties] of Object.entries(overrides)) {
      // Skip orphan materials with fake users (editor-only placeholders)
      if (properties.__fakeUser && properties.__isOrphan) {
        console.log('⏭️ RUNTIME: Skipping orphan material with fake user: ' + materialName + ' (editor-only)');
        continue;
      }
      
      const shaderType = properties.metadata?.shaderType;
      const snippetId = properties.metadata?.shaderSnippetId;
      const shaderSource = properties.metadata?.shaderSource;
      
      // Only look for materials by name (stable identifier)
      let material = scene.materials.find(m => m.name === materialName);
      console.log('🔍 RUNTIME: Looking for material by name: "' + materialName + '", found:', !!material);
      
      // If material doesn't exist but we have metadata, create it based on shader type
      if (!material && shaderType) {
        console.log('🎨 RUNTIME: Material "' + materialName + '" not found, creating new ' + shaderType + ' material');
        
        if (shaderType === 'pbr') {
          // Create PBR material
          material = new BABYLON.PBRMaterial(materialName, scene);
          console.log('✅ RUNTIME: Created PBR material: ' + materialName);
        } else if (shaderType === 'standard') {
          // Create Standard material
          material = new BABYLON.StandardMaterial(materialName, scene);
          console.log('✅ RUNTIME: Created Standard material: ' + materialName);
        } else if (shaderType === 'custom' && snippetId && shaderSource === 'url') {
          // Create NME shader material
          console.log('🎨 RUNTIME: Creating custom NME shader material: ' + materialName + ' from snippet ' + snippetId);
          // NME shaders need to be loaded asynchronously, handle below
        }
        
        // Assign the newly created material to meshes that need it
        if (material && EXPORTED_SCENE_GRAPH.nodes) {
          let meshesAssigned = 0;
          EXPORTED_SCENE_GRAPH.nodes.forEach(function(node) {
            if (node.metadata?.materialName === materialName) {
              const mesh = scene.getMeshById(node.id) || 
                          scene.getMeshByName(node.name) ||
                          scene.meshes.find(function(m) { return m.metadata?.graphNodeId === node.id; });
              
              if (mesh) {
                console.log('🔗 RUNTIME: Assigning ' + shaderType + ' material "' + materialName + '" to mesh: ' + mesh.name);
                mesh.material = material;
                meshesAssigned++;
              }
            }
          });
          console.log('📊 RUNTIME: Assigned ' + shaderType + ' material "' + materialName + '" to ' + meshesAssigned + ' mesh(es)');
        }
      }
      
      // If it's a custom shader with NME snippet and not found, try to create it asynchronously
      if (!material && shaderType === 'custom' && snippetId && shaderSource === 'url') {
        console.log('🎨 RUNTIME: Creating custom NME shader material: ' + materialName + ' from snippet ' + snippetId);
        try {
          const formattedSnippetId = snippetId.startsWith('#') ? snippetId : '#' + snippetId;
          BABYLON.NodeMaterial.ParseFromSnippetAsync(formattedSnippetId, scene).then(function(nodeMaterial) {
            if (nodeMaterial) {
              nodeMaterial.name = materialName;
              nodeMaterial.build(false);
              
              // Find all meshes that should use this material
              let meshesAssigned = 0;
              
              // First, try to find meshes by checking scene graph nodes
              if (EXPORTED_SCENE_GRAPH.nodes) {
                EXPORTED_SCENE_GRAPH.nodes.forEach(function(node) {
                  if (node.metadata?.materialName === materialName) {
                    const mesh = scene.getMeshById(node.id) || 
                                scene.getMeshByName(node.name) ||
                                scene.meshes.find(function(m) { return m.metadata?.graphNodeId === node.id; });
                    
                    if (mesh) {
                      console.log('🔗 RUNTIME: Assigning NME shader "' + materialName + '" to mesh: ' + mesh.name + ' (from scene graph)');
                      mesh.material = nodeMaterial;
                      meshesAssigned++;
                    }
                  }
                });
              }
              
              // Fallback: check if any mesh's current material name matches
              if (meshesAssigned === 0) {
                scene.meshes.forEach(function(mesh) {
                  if (mesh.material && mesh.material.name === materialName) {
                    console.log('🔗 RUNTIME: Assigning NME shader to mesh: ' + mesh.name + ' (by material name match)');
                    mesh.material = nodeMaterial;
                    meshesAssigned++;
                  }
                });
              }
              
              console.log('📊 RUNTIME: Assigned NME shader "' + materialName + '" to ' + meshesAssigned + ' mesh(es)');
              console.log('✅ RUNTIME: Created and assigned NME shader material: ' + materialName);
            }
          }).catch(function(error) {
            console.error('❌ RUNTIME: Failed to load NME shader for ' + materialName + ':', error);
          });
        } catch (error) {
          console.error('❌ RUNTIME: Error creating NME shader material:', error);
        }
        continue; // Skip property application for now, will be applied when NME loads
      }
      
      // Also handle the case where material exists but needs to be replaced with NME shader
      if (material && shaderType === 'custom' && snippetId && shaderSource === 'url') {
        if (!(material instanceof BABYLON.NodeMaterial)) {
          console.log('🎨 RUNTIME: Replacing existing material with NME shader: ' + materialName);
          try {
            const formattedSnippetId = snippetId.startsWith('#') ? snippetId : '#' + snippetId;
            BABYLON.NodeMaterial.ParseFromSnippetAsync(formattedSnippetId, scene).then(function(nodeMaterial) {
              if (nodeMaterial) {
                nodeMaterial.name = materialName;
                nodeMaterial.build(false);
                scene.meshes.forEach(function(mesh) {
                  if (mesh.material === material) {
                    mesh.material = nodeMaterial;
                  }
                });
                material.dispose();
                material = nodeMaterial;
                console.log('✅ RUNTIME: Replaced material with NME shader: ' + materialName);
              }
            }).catch(function(error) {
              console.error('❌ RUNTIME: Failed to replace material with NME shader:', error);
            });
          } catch (error) {
            console.error('❌ RUNTIME: Error replacing material with NME shader:', error);
          }
        }
      }
      
      if (material) {
        console.log('✨ RUNTIME: Applying overrides to material:', material.name, 'uniqueId:', material.uniqueId);
        console.log('✨ RUNTIME: Properties to apply:', properties);
        
        // Apply each property override
        for (const [property, value] of Object.entries(properties)) {
          if (property.startsWith('__')) { // Skip internal metadata properties
            continue;
          }
          try {
              console.log('🔍 RUNTIME: Processing property:', property, 'value:', value, 'isTexture:', isTextureProperty(property));
              
              if (typeof value === 'string' && isTextureProperty(property)) {
                console.log('📸 RUNTIME: Loading texture for property:', property, 'from path:', value);
                
                // Store reference to original texture before replacing
                const originalTexture = material[property];
                console.log('🔍 RUNTIME: Original texture for', property + ':', originalTexture ? (originalTexture.name || originalTexture.url) : 'none');
                if (originalTexture) {
                  console.log('🔍 RUNTIME: Original texture details:', {
                    name: originalTexture.name,
                    url: originalTexture.url,
                    coordinatesIndex: originalTexture.coordinatesIndex,
                    hasEmbeddedHash: originalTexture.url && originalTexture.url.includes('#')
                  });
                }

                // Selective override logic (mimic viewer): avoid replacing identical GLTF textures
                const currentPath = originalTexture ? (originalTexture.url || originalTexture.name || '') : '';
                const currentFile = getFilenameFromUrl(currentPath);
                const overrideFile = getFilenameFromUrl(value);
                const isEmbedded = !!(originalTexture && originalTexture.url && originalTexture.url.includes('#'));
                const shouldApplyOverride = !originalTexture || isEmbedded || (currentFile !== overrideFile && !!overrideFile);
                console.log('🔍 RUNTIME: Texture comparison for', property, { currentFile, overrideFile, isEmbedded, shouldApplyOverride });
                if (!shouldApplyOverride) {
                  console.log('🔍 RUNTIME: Keeping original GLTF texture for', property, '(', currentPath, ')');
                  continue;
                }
                
                const tex = loadTextureFromAssetPath(value, scene);
                if (tex) {
                  // CRITICAL: Copy UV channel and texture properties from original GLTF texture
                  if (originalTexture) {
                    // Copy UV channel settings (these preserve GLTF UV mapping)
                    if ('coordinatesIndex' in originalTexture && typeof originalTexture.coordinatesIndex === 'number') {
                      tex.coordinatesIndex = originalTexture.coordinatesIndex;
                      console.log('🔄 RUNTIME: Copied coordinatesIndex (UV channel):', originalTexture.coordinatesIndex);
                    }
                    
                    // Copy other important texture properties that affect UV mapping
                    if ('uOffset' in originalTexture) tex.uOffset = originalTexture.uOffset;
                    if ('vOffset' in originalTexture) tex.vOffset = originalTexture.vOffset;
                    if ('uScale' in originalTexture) tex.uScale = originalTexture.uScale;
                    if ('vScale' in originalTexture) tex.vScale = originalTexture.vScale;
                    if ('uAng' in originalTexture) tex.uAng = originalTexture.uAng;
                    if ('vAng' in originalTexture) tex.vAng = originalTexture.vAng;
                    if ('wAng' in originalTexture) tex.wAng = originalTexture.wAng;
                    
                    // Copy wrapping modes
                    if ('wrapU' in originalTexture) tex.wrapU = originalTexture.wrapU;
                    if ('wrapV' in originalTexture) tex.wrapV = originalTexture.wrapV;
                    
                    console.log('✅ RUNTIME: Copied UV properties from original texture');
                  } else {
                    // No original texture to copy from (might be embedded or first time assignment)
                    // Set reasonable defaults for common texture types
                    if (property === 'ambientTexture' || property === 'lightmapTexture') {
                      // Ambient/lightmap textures typically use UV2 (coordinatesIndex 1)
                      tex.coordinatesIndex = 1;
                      console.log('🔄 RUNTIME: Set default UV channel for', property + ': 1 (UV2)');
                    } else {
                      // Most other textures use UV1 (coordinatesIndex 0)
                      tex.coordinatesIndex = 0;
                      console.log('🔄 RUNTIME: Set default UV channel for', property + ': 0 (UV1)');
                    }
                  }
                  
                  material[property] = tex;
                  
                  // Handle lightmap-specific properties
                  if (property === 'lightmapTexture') {
                    material.useLightmapAsShadowmap = true;
                    console.log('🔧 RUNTIME: Enabled useLightmapAsShadowmap for lightmap texture');
                  }
                  
                  console.log('✅ RUNTIME: Applied texture to material:', materialName + '.' + property, 'with UV channel:', tex.coordinatesIndex);
                } else {
                  console.warn('❌ RUNTIME: Skipping texture override due to load failure:', property, value);
                }
              } else {
                // Handle non-texture properties
                // Special handling for color properties (stored as arrays, need to convert to Color3)
                if (property.includes('Color') && Array.isArray(value) && value.length === 3) {
                  material[property] = new BABYLON.Color3(value[0], value[1], value[2]);
                  console.log('✅ RUNTIME: Applied color property:', materialName + '.' + property + ' = [' + value.join(', ') + ']');
                } else {
                  material[property] = value;
                  console.log('✅ RUNTIME: Applied non-texture property:', materialName + '.' + property + ' = ' + value);
                }
                
                // Special handling for lightmap shadow mapping
                if (property === 'useLightmapAsShadowmap') {
                  console.log('🔧 RUNTIME: Applied useLightmapAsShadowmap:', value);
                }
              }
            
            // Handle wireframe for materials that aren't ready yet (common with imported assets)
            if (property === 'wireframe' && material.isReady && !material.isReady()) {
              console.log('🔧 Runtime material ' + materialName + ' not ready (likely imported asset), re-applying wireframe after delay...');
              
              // For imported materials, re-apply wireframe after a short delay
              setTimeout(function() {
                try {
                  material.wireframe = value;
                  console.log('✅ Re-applied wireframe to imported material ' + materialName + ': ' + value);
                } catch (e) {}
              }, 200);
            }
          } catch (error) {
            console.warn('Failed to apply material override ' + property + ':', error);
          }
        }
      } else {
        console.warn('❌ Material not found for override:', materialName);
        console.log('Available material names:', scene.materials.map(m => m.name));
      }
    }
  }

  // Convert storage path to relative asset path (preserve folders after '/assets/' or after '/projects/<id>/')
  function toRelativeAssetPath(storagePath) {
    const pathStr = String(storagePath);
    // 1) If looks like '<uid>/projects/<projectId>/...', keep everything after projectId
    //    This preserves the full path: assets/subfolder/file.ext OR root file.ext
    const parts = pathStr.split('/');
    const projIdx = parts.indexOf('projects');
    if (projIdx >= 0 && parts.length > projIdx + 2) {
      const after = parts.slice(projIdx + 2).join('/');
      if (after) return after;
    }
    // 2) If contains '/assets/', keep everything INCLUDING 'assets/'
    const assetsMarker = '/assets/';
    const idx = pathStr.indexOf(assetsMarker);
    if (idx >= 0) {
      return pathStr.substring(idx + 1); // +1 to skip the leading '/'
    }
    // 3) Fallback to filename (keep at root, don't add assets/ prefix)
    const filename = parts[parts.length - 1];
    if (filename) return filename; // Return bare filename for root assets
    // 4) Ultimate fallback: sanitize path without regex
    return pathStr.split('/').join('_').split('\\').join('_');
  }

  // Apply physics properties to a single object (from viewer.js)
  function applyPhysicsToObject(babylonObject, physicsProps, scene, node = null) {
    if (!babylonObject || !physicsProps) return;
    
    try {
      let targetMesh = babylonObject;
      
      // Handle child meshes from imported GLB files (using the established pattern)
      if (node && node.id.includes(MESH_TAG) && node.parentId) {
        const token = getChildTokenFromId(node.id);
        
        if (token) {
          // Primary: find by stableId in metadata
          targetMesh = scene.meshes.find(m => m.metadata && m.metadata.stableId === token);
          
          // Legacy fallback: find by numeric uniqueId  
          if (!targetMesh && /^\d+$/.test(token)) {
            const uniq = parseInt(token, 10);
            targetMesh = scene.meshes.find(m => m.uniqueId === uniq);
          }
          
          if (targetMesh) {
            console.log('🎯 Resolved child mesh for physics:', targetMesh.name, 'from token:', token);
          } else {
            console.warn('⚠️ Could not resolve child mesh for token:', token);
            return;
          }
        }
      }
      
      // Remove existing impostor if any
      if (targetMesh.physicsImpostor) {
        targetMesh.physicsImpostor.dispose();
        targetMesh.physicsImpostor = null;
      }
      
      // Check if this should be a raw Ammo collider (meshCollider type or legacy isCollider flag)
      if (physicsProps.impostor === 'meshCollider' || (physicsProps.isCollider && isImportedMesh(targetMesh))) {
        console.log('🔷 Creating raw Ammo collider for mesh:', targetMesh.name);
        createRawAmmoCollider(targetMesh, physicsProps);
        return;
      }
      
      // Map impostor types from our format to Babylon.js constants
      const impostorTypeMap = {
        'box': BABYLON.PhysicsImpostor.BoxImpostor,
        'sphere': BABYLON.PhysicsImpostor.SphereImpostor,
        'capsule': BABYLON.PhysicsImpostor.CapsuleImpostor,
        'cylinder': BABYLON.PhysicsImpostor.CylinderImpostor,
        'mesh': BABYLON.PhysicsImpostor.MeshImpostor,
        'convexHull': BABYLON.PhysicsImpostor.ConvexHullImpostor
      };
      
      const impostorType = impostorTypeMap[physicsProps.impostor] || BABYLON.PhysicsImpostor.BoxImpostor;
      
      // Set mass based on physics type
      let mass = 0; // Default for static
      if (physicsProps.type === 'dynamic') {
        mass = physicsProps.mass || 1;
      } else if (physicsProps.type === 'kinematic') {
        mass = 0; // Kinematic bodies have 0 mass but can be moved
      }
      
      // Create impostor options
      const impostorOptions = {
        mass: mass,
        restitution: physicsProps.restitution || 0.3,
        friction: physicsProps.friction || 0.5
      };
      
      // Create physics impostor
      targetMesh.physicsImpostor = new BABYLON.PhysicsImpostor(
        targetMesh,
        impostorType,
        impostorOptions,
        scene
      );
      
      // Apply additional physics properties
      if (physicsProps.isTrigger) {
        // For triggers, disable collision response
        const physicsBody = targetMesh.physicsImpostor.physicsBody;
        if (physicsBody && physicsBody.setCollisionFlags) {
          physicsBody.setCollisionFlags(4); // Trigger flag
        }
      }
      
      console.log('🔷 Created ' + physicsProps.type + ' ' + physicsProps.impostor + ' impostor with mass ' + mass + ' on ' + targetMesh.name);
      
    } catch (error) {
      console.error('❌ Failed to apply physics to ' + targetMesh.name + ':', error);
    }
  }

  // Check if a mesh is from an imported model (not a primitive)
  function isImportedMesh(babylonObject) {
    return (babylonObject.metadata && babylonObject.metadata.gltf) ||
           babylonObject.name.includes('primitive') === false ||
           babylonObject.parent !== null;
  }

  // Create a raw Ammo collider for complex imported meshes (like reference project)
  function createRawAmmoCollider(babylonObject, physicsProps) {
    if (!ammoWorld) {
      console.error('❌ Cannot create raw Ammo collider: ammoWorld not available');
      return;
    }

    try {
      console.log('🔷 Creating raw Ammo collider for imported mesh:', babylonObject.name);
      
      // Refresh bounding info and get geometry data
      babylonObject.refreshBoundingInfo();
      const positions = babylonObject.getVerticesData(BABYLON.VertexBuffer.PositionKind);
      const indices = babylonObject.getIndices();

      if (!positions || !indices) {
        console.error('❌ ' + babylonObject.name + ' missing geometry data for collider');
        return;
      }

      // Create Ammo triangle mesh (like reference project)
      const ammoMesh = new Ammo.btTriangleMesh(true, true);
      const scale = babylonObject.scaling;

      // Add each triangle to the Ammo mesh
      for (let i = 0; i < indices.length; i += 3) {
        const i0 = indices[i] * 3;
        const i1 = indices[i + 1] * 3;
        const i2 = indices[i + 2] * 3;

        // Create vertices with scaling applied (like reference project)
        const v0 = new Ammo.btVector3(-positions[i0] * scale.x, positions[i0 + 1] * scale.y, positions[i0 + 2] * scale.z);
        const v1 = new Ammo.btVector3(-positions[i1] * scale.x, positions[i1 + 1] * scale.y, positions[i1 + 2] * scale.z);
        const v2 = new Ammo.btVector3(-positions[i2] * scale.x, positions[i2 + 1] * scale.y, positions[i2 + 2] * scale.z);

        ammoMesh.addTriangle(v0, v1, v2, true);
      }

      // Create BVH triangle mesh shape
      const shape = new Ammo.btBvhTriangleMeshShape(ammoMesh, true, true);
      shape.setLocalScaling(new Ammo.btVector3(-scale.x, scale.y, scale.z));

      // Create transform
      const transform = new Ammo.btTransform();
      transform.setIdentity();
      const origin = babylonObject.getAbsolutePosition();
      transform.setOrigin(new Ammo.btVector3(origin.x, origin.y, origin.z));
      transform.setRotation(new Ammo.btQuaternion(0, 0, 0, 1));

      // Create rigid body (static collider)
      const motionState = new Ammo.btDefaultMotionState(transform);
      const localInertia = new Ammo.btVector3(0, 0, 0);
      const mass = 0; // Static collider
      const rbInfo = new Ammo.btRigidBodyConstructionInfo(mass, motionState, shape, localInertia);
      const body = new Ammo.btRigidBody(rbInfo);

      // Add to physics world
      ammoWorld.addRigidBody(body);

      // Store reference for cleanup
      babylonObject._ammoBody = body;
      babylonObject._isRawAmmoCollider = true;

      console.log('✅ Raw Ammo collider created for ' + babylonObject.name + ' with ' + (indices.length/3) + ' triangles');

    } catch (error) {
      console.error('❌ Failed to create raw Ammo collider for ' + babylonObject.name + ':', error);
    }
  }

  // Setup dynamic zoom sensitivity for user cameras (similar to editor camera)
  function setupUserCameraDynamicZoom(camera, baseSensitivity) {
    if (!camera) return;

    // Clear any existing observers to avoid duplicates
    if (camera._dynamicZoomObserver) {
      camera.onAfterCheckInputsObservable.remove(camera._dynamicZoomObserver);
    }

    // Add observer to dynamically adjust zoom sensitivity based on distance
    const observer = camera.onAfterCheckInputsObservable.add(function() {
      if (camera.mode === BABYLON.Camera.ORTHOGRAPHIC_CAMERA) return;

      const currentRadius = camera.radius;
      
      // Dynamic sensitivity based on distance (same algorithm as editor camera)
      const closeDistance = 2.0;      // Distance considered "close" where zoom slows down most
      const normalDistance = 20.0;    // Distance where zoom becomes normal
      const minMultiplier = 0.8;      // 80% of base when very close
      const maxMultiplier = 2.0;      // 200% of base when far
      
      // Calculate zoom sensitivity using smooth curve
      let multiplier;
      
      if (currentRadius <= closeDistance) {
        // Very close: use minimum multiplier
        multiplier = minMultiplier;
      } else if (currentRadius >= normalDistance) {
        // Far away: use maximum multiplier
        multiplier = maxMultiplier;
      } else {
        // Interpolate smoothly between close and normal distance
        const t = (currentRadius - closeDistance) / (normalDistance - closeDistance);
        // Use smooth step function for gradual transition
        const smoothT = t * t * (3.0 - 2.0 * t);
        multiplier = minMultiplier + (maxMultiplier - minMultiplier) * smoothT;
      }
      
      // Apply the dynamic sensitivity based on user's base setting
      camera.wheelDeltaPercentage = baseSensitivity * multiplier;
    });

    // Store observer reference for cleanup
    camera._dynamicZoomObserver = observer;
    camera._baseSensitivity = baseSensitivity;
  }

  // Input Control System (synced with viewer.js)
  function createInputControlManager(scene, sceneGraph) {
    return {
      scene: scene,
      sceneGraph: sceneGraph,
      controlledObjects: new Map(),
      activeKeys: new Set(),
      activeKeyBindings: new Set(), // Track full key combinations (ctrl+shift+alt+key)
      currentModifiers: { ctrl: false, shift: false, alt: false }, // Track current modifier state
      isEnabled: true,
      updateInterval: null,
      globalInputControls: loadGlobalInputControls(sceneGraph),
      
      // Key binding helper functions (synced with viewer.js)
      createKeyBindingString: function(ctrl, shift, alt, key) {
        const parts = [];
        if (ctrl) parts.push('ctrl');
        if (shift) parts.push('shift');
        if (alt) parts.push('alt');
        parts.push(key);
        return parts.join('+');
      },
      
      keyBindingMatches: function(keyBinding, activeBindings) {
        if (!keyBinding) return false;
        
        // Handle modifier-only keys (when no specific key is set, only modifiers)
        if (!keyBinding.key || keyBinding.key === '') {
          // For modifier-only keys, check if the modifiers match current state exactly
          const ctrlMatch = keyBinding.ctrl === this.currentModifiers.ctrl;
          const shiftMatch = keyBinding.shift === this.currentModifiers.shift;
          const altMatch = keyBinding.alt === this.currentModifiers.alt;
          
          // At least one modifier must be required
          const hasRequiredModifier = keyBinding.ctrl || keyBinding.shift || keyBinding.alt;
          
          const modifiersMatch = ctrlMatch && shiftMatch && altMatch && hasRequiredModifier;
          
          if (modifiersMatch) {
            console.log('🎮 Modifier-only key binding match: ctrl:' + keyBinding.ctrl + '/' + this.currentModifiers.ctrl + ' shift:' + keyBinding.shift + '/' + this.currentModifiers.shift + ' alt:' + keyBinding.alt + '/' + this.currentModifiers.alt);
          }
          return modifiersMatch;
        }
        
        // For key+modifier combinations, use the activeBindings approach
        const originalBinding = this.createKeyBindingString(keyBinding.ctrl, keyBinding.shift, keyBinding.alt, keyBinding.key);
        let keyCodeBinding = originalBinding;
        
        // Convert single letters to KeyCode format (Q -> KeyQ)
        if (keyBinding.key.length === 1 && /[A-Z]/.test(keyBinding.key)) {
          const keyCodeKey = 'Key' + keyBinding.key.toUpperCase();
          keyCodeBinding = this.createKeyBindingString(keyBinding.ctrl, keyBinding.shift, keyBinding.alt, keyCodeKey);
        }
        
        const originalMatches = activeBindings.has(originalBinding);
        const keyCodeMatches = activeBindings.has(keyCodeBinding);
        const matches = originalMatches || keyCodeMatches;
        
        if (matches) {
          console.log('🎮 Key binding match: ' + (originalMatches ? originalBinding : keyCodeBinding) + ' matches active bindings');
        }
        return matches;
      }
    };
  }

  function loadGlobalInputControls(sceneGraph) {
    // Try to get project ID from URL or scene metadata
    const urlParams = new URLSearchParams(window.location.search);
    const projectId = urlParams.get('projectId') || sceneGraph?.metadata?.projectId;
    
    if (!projectId) {
      console.warn('🎮 No project ID found, using default input controls');
      return {
        'Input Control 1': {
          idleAnimationName: '',
          blendTime: 0.2,
          speed: 5,
          speedBoostEnabled: false,
          speedBoostKey: { ctrl: false, shift: false, alt: false, key: '', multiplier: 2 },
          forward: { keyBinding: { ctrl: false, shift: false, alt: false, key: 'KeyW' }, animationName: '' },
          backward: { keyBinding: { ctrl: false, shift: false, alt: false, key: 'KeyS' }, animationName: '' },
          turnLeft: { keyBinding: { ctrl: false, shift: false, alt: false, key: 'KeyA' }, animationName: '' },
          turnRight: { keyBinding: { ctrl: false, shift: false, alt: false, key: 'KeyD' }, animationName: '' },
          jump: { keyBinding: { ctrl: false, shift: false, alt: false, key: 'Space' }, animationName: '', backwardAnimationName: '' }
        }
      };
    }
    
    const settingsKey = 'project_settings_' + projectId;
    const stored = localStorage.getItem(settingsKey);
    
    if (!stored) {
      console.warn('🎮 No project settings found, using default input controls');
      return {
        'Input Control 1': {
          idleAnimationName: '',
          blendTime: 0.2,
          speed: 5,
          speedBoostEnabled: false,
          speedBoostKey: { ctrl: false, shift: false, alt: false, key: '', multiplier: 2 },
          forward: { keyBinding: { ctrl: false, shift: false, alt: false, key: 'KeyW' }, animationName: '' },
          backward: { keyBinding: { ctrl: false, shift: false, alt: false, key: 'KeyS' }, animationName: '' },
          turnLeft: { keyBinding: { ctrl: false, shift: false, alt: false, key: 'KeyA' }, animationName: '' },
          turnRight: { keyBinding: { ctrl: false, shift: false, alt: false, key: 'KeyD' }, animationName: '' },
          jump: { keyBinding: { ctrl: false, shift: false, alt: false, key: 'Space' }, animationName: '', backwardAnimationName: '' }
        }
      };
    }
    
    try {
      const settings = JSON.parse(stored);
      return settings.globalInputControls || {};
    } catch (error) {
      console.error('🎮 Failed to parse global input controls:', error);
      return {};
    }
  }

  function initializeInputControls(manager) {
    setupKeyboardListeners(manager);
    scanForControlledObjects(manager);
    startInputUpdateLoop(manager);
  }

  function setupKeyboardListeners(manager) {
    window.addEventListener('keydown', function(event) {
      if (!manager.isEnabled) return;
      
      const key = event.code || event.key;
      const normalizedKey = key === ' ' ? 'Space' : key;
      
      // Update modifier state
      manager.currentModifiers.ctrl = event.ctrlKey || event.metaKey;
      manager.currentModifiers.shift = event.shiftKey;
      manager.currentModifiers.alt = event.altKey;
      
      if (!manager.activeKeys.has(normalizedKey)) {
        manager.activeKeys.add(normalizedKey);
        
        // Create key binding string for tracking combinations
        const keyBinding = manager.createKeyBindingString(manager.currentModifiers.ctrl, manager.currentModifiers.shift, manager.currentModifiers.alt, normalizedKey);
        manager.activeKeyBindings.add(keyBinding);
        
        handleKeyDown(manager, normalizedKey, event);
        console.log('🎮 Key combination pressed: ' + keyBinding);
      }
      
      if (isMovementKey(manager, normalizedKey)) {
        event.preventDefault();
      }
    });

    window.addEventListener('keyup', function(event) {
      if (!manager.isEnabled) return;
      
      const key = event.code || event.key;
      const normalizedKey = key === ' ' ? 'Space' : key;
      
      // Update modifier state
      manager.currentModifiers.ctrl = event.ctrlKey || event.metaKey;
      manager.currentModifiers.shift = event.shiftKey;
      manager.currentModifiers.alt = event.altKey;
      
      manager.activeKeys.delete(normalizedKey);
      
      // Remove key binding combinations that used this key
      const keyBindingsToRemove = [];
      for (const binding of manager.activeKeyBindings) {
        if (binding.endsWith('+' + normalizedKey) || binding === normalizedKey) {
          keyBindingsToRemove.push(binding);
        }
      }
      keyBindingsToRemove.forEach(function(binding) { 
        manager.activeKeyBindings.delete(binding); 
      });
      
      handleKeyUp(manager, normalizedKey, event);
    });
  }

  function isMovementKey(manager, key) {
    // Check if this key is used by the active controlled object (synced with viewer.js)
    for (const [nodeId, controlData] of manager.controlledObjects) {
      const inputControl = controlData.inputControl;
      if (inputControl.active && (inputControl.locomotionType === 'Grounded Avatar' || inputControl.locomotionType === 'Input Control 1')) {
        const movements = ['forward', 'backward', 'turnLeft', 'turnRight', 'jump'];
        for (const movement of movements) {
          if (inputControl[movement] && inputControl[movement].keyBinding && inputControl[movement].keyBinding.key === key) {
            return true;
          }
        }
        // Also check speed boost key
        if (inputControl.speedBoostKey && inputControl.speedBoostKey.key === key) {
          return true;
        }
      }
    }
    return false;
  }

  function scanForControlledObjects(manager) {
    if (!manager.sceneGraph || !manager.sceneGraph.nodes) return;

    let foundCount = 0;
    
    for (const node of manager.sceneGraph.nodes) {
      // Skip deleted objects
      if (node.metadata && node.metadata.deleted === true) continue;
      
      if (node.inputControl && node.inputControl.locomotionType !== 'none') {
        const babylonObject = manager.scene.getNodeById(node.id);
        if (babylonObject) {
          // Use input control data directly from scene.json (synced with viewer.js)
          const inputControl = node.inputControl;
          
          const animationGroups = getAnimationGroupsForObject(manager.scene, babylonObject);
          
          manager.controlledObjects.set(node.id, {
            object: babylonObject,
            inputControl: inputControl,
            animations: animationGroups,
            nodeData: node,
            jumpState: {
              isJumping: false,
              jumpVelocity: 0,
              groundY: babylonObject.position.y
            },
            currentAnimation: null,
            isMoving: false
          });
          
          // Initialize control rotation for physics objects - preserve Y rotation from editor
          if (babylonObject.physicsImpostor) {
            // Preserve the Y rotation that was set in the editor
            const initialYRotation = node.transform?.rotation?.[1] || 0;
            babylonObject._controlRotation = initialYRotation;
            
            // Apply the initial rotation to child meshes so they visually face the correct direction
            if (initialYRotation !== 0) {
              rotateChildNodes(babylonObject, initialYRotation);
              console.log('🎯 Applied initial rotation of', initialYRotation.toFixed(3), 'rad (' + (initialYRotation * 180 / Math.PI).toFixed(1) + '°) to child meshes of', node.name);
            }
            
            console.log('🎯 Initialized control rotation for physics object:', node.name, 'preserving Y rotation:', initialYRotation.toFixed(3), 'rad', '(' + (initialYRotation * 180 / Math.PI).toFixed(1) + '°)');
          }
          
          foundCount++;
          console.log('🎮 Found controlled object:', node.name, '(' + node.inputControl.locomotionType + ')');
          console.log('🎬 Available animations for ' + node.name + ':', animationGroups.map(function(ag) { return ag.name; }));
          
          // Start idle animation if specified and animations are available
          if (animationGroups.length > 0) {
            playIdleAnimation(manager, node.id);
          }
        }
      }
    }
    
    console.log('🎮 Found ' + foundCount + ' objects with input controls');
  }

  // Helper function to rotate child nodes (synced with viewer.js)
  function rotateChildNodes(parentNode, yRotation) {
    if (!parentNode || !parentNode.getChildMeshes) return;
    
    const childMeshes = parentNode.getChildMeshes();
    for (const childMesh of childMeshes) {
      if (childMesh.rotation) {
        childMesh.rotation.y += yRotation;
      }
    }
  }

  function getAnimationGroupsForObject(scene, babylonObject) {
    if (!scene.animationGroups || scene.animationGroups.length === 0) {
      return [];
    }

    const commonAnimationNames = ['idle', 'walk', 'run', 'jump', 'walk_backward', 'run_backward'];
    const foundByName = [];
    
    for (const name of commonAnimationNames) {
      let animGroup = scene.getAnimationGroupByName(name);
      if (!animGroup) {
        animGroup = scene.animationGroups.find(function(ag) { 
          return ag.name && ag.name.toLowerCase() === name.toLowerCase(); 
        });
      }
      if (animGroup && !foundByName.includes(animGroup)) {
        foundByName.push(animGroup);
        console.log('📛 Found animation by name: "' + animGroup.name + '"');
      }
    }

    return foundByName;
  }

  function playIdleAnimation(manager, nodeId) {
    const controlData = manager.controlledObjects.get(nodeId);
    if (!controlData || !controlData.inputControl.idleAnimationId) return;
    
    if (!controlData.isMoving) {
      playMovementAnimation(manager, controlData.inputControl.idleAnimationId, controlData, 0.15);
    }
  }

  function playMovementAnimation(manager, animationId, controlData, blendTime) {
    if (!animationId) return;
    
    const targetAnimation = controlData.animations.find(function(ag) { return ag.name === animationId; });
    if (!targetAnimation) {
      console.warn('⚠️ Animation "' + animationId + '" not found');
      return;
    }

    if (controlData.currentAnimation === targetAnimation) {
      return;
    }

    console.log('🔄 Blending to animation: ' + animationId + ' (blend time: ' + blendTime + 's)');

    // Stop current animation
    if (controlData.currentAnimation) {
      controlData.currentAnimation.stop();
    }

    // Start new animation
    targetAnimation.start(true, 1.0, targetAnimation.from, targetAnimation.to, false);
    controlData.currentAnimation = targetAnimation;
    
    // Simple blend completion callback
    setTimeout(function() {
      console.log('✅ Animation blend completed: ' + animationId);
    }, (blendTime || 0.15) * 1000);
  }

  function handleKeyDown(manager, key, event) {
    // Only respond to the active controller
    for (const [nodeId, controlData] of manager.controlledObjects) {
      const inputControl = controlData.inputControl;
      
      // Only process input for the active controller (synced with viewer.js)
      if (inputControl.active && (inputControl.locomotionType === 'Grounded Avatar' || inputControl.locomotionType === 'Input Control 1')) {
        handleGroundedInput(manager, key, controlData, event);
      }
    }
  }

  function handleKeyUp(manager, key, event) {
    // Only respond to the active controller
    for (const [nodeId, controlData] of manager.controlledObjects) {
      const inputControl = controlData.inputControl;
      
      // Only process input for the active controller (synced with viewer.js)
      if (inputControl.active && (inputControl.locomotionType === 'Grounded Avatar' || inputControl.locomotionType === 'Input Control 1')) {
        stopMovementAnimation(manager, key, controlData, event);
      }
    }
  }

  function handleGroundedInput(manager, key, controlData, event) {
    const object = controlData.object;
    const inputControl = controlData.inputControl;
    const movements = ['forward', 'backward', 'turnLeft', 'turnRight', 'jump'];
    
    // Helper function to check if key binding matches current key press (synced with viewer.js)
    function keyMatches(keyBinding) {
      return manager.keyBindingMatches(keyBinding, manager.activeKeyBindings);
    }
    
    // Check if this key press corresponds to any movement
    let isMovementKey = false;
    for (const movement of movements) {
      const movementControl = inputControl[movement];
      if (keyMatches(movementControl && movementControl.keyBinding)) {
        console.log('🎮 ' + movement + ' key pressed for ' + object.name);
        isMovementKey = true;
        
        controlData.isMoving = true;
        applyMovement(manager, movement, controlData);
        break;
      }
    }
    
    if (isMovementKey) {
      updateMovementAnimation(manager, controlData);
    }
  }

  function stopMovementAnimation(manager, key, controlData) {
    const inputControl = controlData.inputControl;
    
    // Check if this key is still active in any movement
    let stillMoving = false;
    const movements = ['forward', 'backward', 'turnLeft', 'turnRight'];
    
    for (const movement of movements) {
      const movementControl = inputControl[movement];
      if (movementControl && movementControl.keyBinding && movementControl.keyBinding.key !== key && 
          manager.activeKeys.has(movementControl.keyBinding.key)) {
        stillMoving = true;
        break;
      }
    }
    
    if (!stillMoving) {
      controlData.isMoving = false;
      console.log('🛑 All movement stopped for ' + controlData.object.name);
      playIdleAnimation(manager, controlData.nodeData.id);
    }
  }

  function updateMovementAnimation(manager, controlData) {
    const inputControl = controlData.inputControl;
    const isSpeedBoosting = inputControl.speedBoostEnabled && 
                           inputControl.speedBoostKey && inputControl.speedBoostKey.key && 
                           manager.activeKeys.has(inputControl.speedBoostKey.key);
    
    let targetAnimation = null;
    
    // Check movement keys in priority order
    if (inputControl.forward && inputControl.forward.keyBinding && manager.activeKeys.has(inputControl.forward.keyBinding.key)) {
      targetAnimation = isSpeedBoosting && inputControl.forward.speedBoostAnimationId ? 
        inputControl.forward.speedBoostAnimationId : inputControl.forward.animationId;
    } else if (inputControl.backward && inputControl.backward.keyBinding && manager.activeKeys.has(inputControl.backward.keyBinding.key)) {
      targetAnimation = isSpeedBoosting && inputControl.backward.speedBoostAnimationId ? 
        inputControl.backward.speedBoostAnimationId : inputControl.backward.animationId;
    } else if (inputControl.turnLeft && inputControl.turnLeft.keyBinding && manager.activeKeys.has(inputControl.turnLeft.keyBinding.key)) {
      targetAnimation = isSpeedBoosting && inputControl.turnLeft.speedBoostAnimationId ? 
        inputControl.turnLeft.speedBoostAnimationId : inputControl.turnLeft.animationId;
    } else if (inputControl.turnRight && inputControl.turnRight.keyBinding && manager.activeKeys.has(inputControl.turnRight.keyBinding.key)) {
      targetAnimation = isSpeedBoosting && inputControl.turnRight.speedBoostAnimationId ? 
        inputControl.turnRight.speedBoostAnimationId : inputControl.turnRight.animationId;
    } else if (inputControl.jump && inputControl.jump.keyBinding && manager.activeKeys.has(inputControl.jump.keyBinding.key)) {
      targetAnimation = isSpeedBoosting && inputControl.jump.speedBoostAnimationId ? 
        inputControl.jump.speedBoostAnimationId : inputControl.jump.animationId;
    }
    
    if (targetAnimation && (!controlData.currentAnimation || targetAnimation !== controlData.currentAnimation.name)) {
      playMovementAnimation(manager, targetAnimation, controlData, 0.15);
    }
  }

  function applyMovement(manager, movement, controlData) {
    const object = controlData.object;
    const inputControl = controlData.inputControl;
    const jumpState = controlData.jumpState;
    
    const baseSpeed = inputControl.speed || 0.1;
    const rotateSpeed = 0.05;
    
    const isSpeedBoosting = inputControl.speedBoostEnabled && 
                           inputControl.speedBoostKey && inputControl.speedBoostKey.key && 
                           manager.activeKeys.has(inputControl.speedBoostKey.key);
    const speedMultiplier = isSpeedBoosting ? (inputControl.speedBoostMultiplier || 2.0) : 1.0;
    const currentSpeed = baseSpeed * speedMultiplier;
    
    const hasPhysics = object.physicsImpostor !== null && object.physicsImpostor !== undefined;
    
    switch (movement) {
      case 'forward':
        const forwardDir = getForwardDirection(object);
        if (hasPhysics) {
          const currentVel = object.physicsImpostor.getLinearVelocity();
          const physicsSpeed = currentSpeed * 100;
          const moveDir = forwardDir.scale(physicsSpeed);
          object.physicsImpostor.setLinearVelocity(new BABYLON.Vector3(
            moveDir.x, 
            currentVel.y,
            moveDir.z
          ));
        } else {
          object.position.addInPlace(forwardDir.scale(currentSpeed));
        }
        break;
        
      case 'backward':
        const backwardDir = getForwardDirection(object);
        if (hasPhysics) {
          const currentVel = object.physicsImpostor.getLinearVelocity();
          const physicsSpeed = currentSpeed * 100;
          const moveDir = backwardDir.scale(-physicsSpeed);
          object.physicsImpostor.setLinearVelocity(new BABYLON.Vector3(
            moveDir.x, 
            currentVel.y,
            moveDir.z
          ));
        } else {
          object.position.addInPlace(backwardDir.scale(-currentSpeed));
        }
        break;
        
      case 'turnLeft':
        if (hasPhysics) {
          if (!object._controlRotation) object._controlRotation = 0;
          object._controlRotation -= rotateSpeed * 1;
          rotateChildNodes(object, -rotateSpeed * 1);
        } else {
          object.rotation.y -= rotateSpeed;
        }
        break;
        
      case 'turnRight':
        if (hasPhysics) {
          if (!object._controlRotation) object._controlRotation = 0;
          object._controlRotation += rotateSpeed * 1;
          rotateChildNodes(object, rotateSpeed * 1);
        } else {
          object.rotation.y += rotateSpeed;
        }
        break;
        
      case 'jump':
        if (hasPhysics) {
          const vel = object.physicsImpostor.getLinearVelocity();
          if (!jumpState.isJumping && Math.abs(vel.y) < 0.5) {
            const jumpHeight = inputControl.jumpHeight || 1.2;
            const g = Math.abs(manager.scene.getPhysicsEngine() && manager.scene.getPhysicsEngine().gravity ? manager.scene.getPhysicsEngine().gravity.y : 9.81);
            const v0 = Math.sqrt(2 * g * jumpHeight);
            const mass = object.physicsImpostor.getParam && object.physicsImpostor.getParam('mass') ? object.physicsImpostor.getParam('mass') : object.physicsImpostor.mass || 1;
            
            object.physicsImpostor.setLinearVelocity(new BABYLON.Vector3(vel.x, 0, vel.z));
            object.physicsImpostor.applyImpulse(
              new BABYLON.Vector3(0, mass * v0, 0),
              object.getAbsolutePosition()
            );
            
            jumpState.isJumping = true;
            console.log('🦘 ' + object.name + ' jumped (physics) v0=' + v0.toFixed(2) + ' m/s');
          }
        } else {
          if (!jumpState.isJumping && object.position.y <= jumpState.groundY + 0.001) {
            const g = 9.81;
            const jumpHeight = inputControl.jumpHeight || 1.2;
            const v0 = Math.sqrt(2 * g * jumpHeight);
            jumpState.isJumping = true;
            jumpState.jumpVelocity = v0;
            console.log('🦘 ' + object.name + ' jumped (non-physics) v0=' + v0.toFixed(2) + ' m/s');
          }
        }
        break;
    }
  }

  function getForwardDirection(object) {
    const hasPhysics = object.physicsImpostor !== null && object.physicsImpostor !== undefined;
    let yRotation;
    
    if (hasPhysics && object._controlRotation !== undefined) {
      yRotation = object._controlRotation;
    } else {
      yRotation = object.rotation.y;
    }
    
    return new BABYLON.Vector3(
      Math.sin(yRotation),
      0,
      Math.cos(yRotation)
    );
  }

  function rotateChildNodes(parentObject, rotationDelta) {
    if (!parentObject.getChildren) return;
    
    const children = parentObject.getChildren();
    for (const child of children) {
      if (child.rotation !== undefined) {
        child.rotation.y += rotationDelta;
        child.rotationQuaternion = null;
      }
    }
  }

  function startInputUpdateLoop(manager) {
    manager.updateInterval = setInterval(function() {
      if (!manager.isEnabled) return;
      
      // Update physics for all controlled objects
      for (const [nodeId, controlData] of manager.controlledObjects) {
        updatePhysicsForObject(manager, controlData);
      }
      
      // Handle held keys
      if (manager.activeKeys.size > 0) {
        for (const key of manager.activeKeys) {
          for (const [nodeId, controlData] of manager.controlledObjects) {
            const inputControl = controlData.inputControl;
            
            if (inputControl.locomotionType === 'Grounded Avatar') {
              handleGroundedInput(manager, key, controlData);
            }
          }
        }
      }
    }, 16); // ~60fps
  }

  function updatePhysicsForObject(manager, controlData) {
    const object = controlData.object;
    const jumpState = controlData.jumpState;
    const hasPhysics = object.physicsImpostor !== null && object.physicsImpostor !== undefined;
    
    if (hasPhysics) {
      // Check if we should stop horizontal movement when no keys are pressed
      const isAnyMovementKeyPressed = hasActiveMovementKeys(manager, controlData);
      
      if (!isAnyMovementKeyPressed) {
        const currentVel = object.physicsImpostor.getLinearVelocity();
        const dampingFactor = 0.85;
        object.physicsImpostor.setLinearVelocity(new BABYLON.Vector3(
          currentVel.x * dampingFactor, 
          currentVel.y,
          currentVel.z * dampingFactor
        ));
        
        object.physicsImpostor.setAngularVelocity(new BABYLON.Vector3(0, 0, 0));
      }
      
      // Keep object upright
      if (object.physicsImpostor) {
        const angVel = object.physicsImpostor.getAngularVelocity();
        object.physicsImpostor.setAngularVelocity(new BABYLON.Vector3(0, angVel.y, 0));
        object.rotationQuaternion = BABYLON.Quaternion.Identity();
      }
      
      // Handle physics-based jump landing
      if (jumpState.isJumping) {
        const currentVel = object.physicsImpostor.getLinearVelocity();
        if (Math.abs(currentVel.y) < 0.5 && object.position.y <= jumpState.groundY + 0.5) {
          jumpState.isJumping = false;
          console.log('🏃 ' + object.name + ' landed');
        }
      }
    } else {
      // Handle non-physics jump
      if (jumpState.isJumping) {
        const gravity = -9.81;
        const deltaTime = 0.016;
        
        jumpState.jumpVelocity += gravity * deltaTime;
        object.position.y += jumpState.jumpVelocity * deltaTime;
        
        if (object.position.y <= jumpState.groundY) {
          object.position.y = jumpState.groundY;
          jumpState.isJumping = false;
          jumpState.jumpVelocity = 0;
          console.log('🏃 ' + object.name + ' landed');
        }
      }
    }
  }

  function hasActiveMovementKeys(manager, controlData) {
    const inputControl = controlData.inputControl;
    const movements = ['forward', 'backward', 'turnLeft', 'turnRight'];
    
    for (const movement of movements) {
      const movementControl = inputControl[movement];
      if (movementControl && movementControl.keyBinding && 
          manager.activeKeys.has(movementControl.keyBinding.key)) {
        return true;
      }
    }
    return false;
  }

  // Camera Shake System for natural camera motion effects
  function createCameraShakeManager(scene, sceneGraph) {
    const manager = {
      scene: scene,
      sceneGraph: sceneGraph,
      cameraShakeTimers: new Map(), // cameraId -> { time, baseTarget, baseAlpha, baseBeta }
      beforeRenderObserver: null, // Store observer reference for disposal
      afterRenderObserver: null, // Store observer reference for disposal
      
      initialize: function() {
        this.scanForShakeCameras();
        this.setupUpdateLoop();
      },
      
      scanForShakeCameras: function() {
        if (!this.sceneGraph || !this.sceneGraph.nodes) return;

        let foundCount = 0;

        for (const node of this.sceneGraph.nodes) {
          // Skip deleted objects
          if (node.metadata && node.metadata.deleted === true) continue;
          
          if (node.kind === 'camera' && node.camera && node.camera.shake && node.camera.shake.preset !== 'none') {
            const babylonCamera = this.scene.getCameraById(node.id);
            
            if (babylonCamera) {
              this.cameraShakeTimers.set(node.id, {
                time: 0,
                baseTarget: babylonCamera instanceof BABYLON.ArcRotateCamera 
                  ? babylonCamera.target.clone() 
                  : babylonCamera.position.clone(),
                baseAlpha: babylonCamera instanceof BABYLON.ArcRotateCamera ? babylonCamera.alpha : 0,
                baseBeta: babylonCamera instanceof BABYLON.ArcRotateCamera ? babylonCamera.beta : 0
              });
              
              foundCount++;
              console.log('📹 Camera shake enabled: ' + node.name + ' (' + node.camera.shake.preset + ')');
            }
          }
        }

        console.log('📹 Found ' + foundCount + ' cameras with shake');
      },
      
      updateCameraShakes: function() {
        const deltaTime = this.scene.getEngine().getDeltaTime();

        for (const [cameraId, shakeState] of this.cameraShakeTimers) {
          const node = this.sceneGraph.nodes.find(function(n) { return n.id === cameraId; });
          if (!node || !node.camera || !node.camera.shake) continue;

          const shake = node.camera.shake;
          if (shake.preset === 'none') continue;

          const camera = this.scene.getCameraById(cameraId);
          if (!camera) continue;

          // Update shake time based on frequency
          const frequency = shake.frequency || 1;
          shakeState.time += deltaTime * 0.001 * frequency;

          // Apply shake based on preset
          if (shake.preset === 'natural') {
            const strength = shake.strength || 1;
            // Scale down parameters by 100x so users can input 0.1, 0.2 instead of 0.001, 0.002
            const posAmp = (shake.positionAmplitude || 0.2) * strength * 0.00002;
            const rotAmp = (shake.rotationAmplitude || 0.002) * strength * 0.00002;

            // Natural idle shake offset (additive)
            const shakeOffsetX = Math.sin(shakeState.time * 0.6) * posAmp;
            const shakeOffsetY = Math.sin(shakeState.time * 0.9) * posAmp;
            const shakeAlpha = Math.sin(shakeState.time * 0.5) * rotAmp;
            const shakeBeta = Math.cos(shakeState.time * 0.4) * rotAmp;

            // Store shake offsets for visual-only application
            // These are applied during rendering but don't modify the actual camera properties
            camera._visualShakeOffset = {
              x: shakeOffsetX,
              y: shakeOffsetY,
              alpha: shakeAlpha,
              beta: shakeBeta
            };
          }
        }
      },
      
      setupUpdateLoop: function() {
        if (this.scene && this.cameraShakeTimers.size > 0) {
          const self = this;
          
          // Apply shake before each frame renders
          this.beforeRenderObserver = this.scene.onBeforeRenderObservable.add(function() {
            self.updateCameraShakes();
            
            // Apply visual shake offsets to cameras (saved to restore later)
            for (const [cameraId, shakeState] of self.cameraShakeTimers) {
              const camera = self.scene.getCameraById(cameraId);
              if (!camera || !camera._visualShakeOffset) continue;
              
              const offset = camera._visualShakeOffset;
              
              // Save current values BEFORE applying shake (so we can restore them after render)
              // This captures the user's current camera position/rotation for this frame
              if (!camera._preShakeThisFrame) {
                camera._preShakeThisFrame = {};
              }
              
              if (camera instanceof BABYLON.ArcRotateCamera) {
                camera._preShakeThisFrame.alpha = camera.alpha;
                camera._preShakeThisFrame.beta = camera.beta;
                camera._preShakeThisFrame.target = camera.target.clone();
                
                // Apply shake ADDITIVELY to current position
                camera.alpha += offset.alpha;
                camera.beta += offset.beta;
                camera.target = camera.target.add(new BABYLON.Vector3(offset.x, offset.y, 0));
              } else {
                camera._preShakeThisFrame.position = camera.position.clone();
                
                // Apply shake ADDITIVELY to current position
                camera.position = camera.position.add(new BABYLON.Vector3(offset.x, offset.y, 0));
              }
            }
          });
          
          // Restore pre-shake values after render to prevent shake from being permanently applied
          this.afterRenderObserver = this.scene.onAfterRenderObservable.add(function() {
            for (const [cameraId] of self.cameraShakeTimers) {
              const camera = self.scene.getCameraById(cameraId);
              if (!camera || !camera._preShakeThisFrame) continue;
              
              if (camera instanceof BABYLON.ArcRotateCamera) {
                if (camera._preShakeThisFrame.target) {
                  camera.target = camera._preShakeThisFrame.target;
                }
                if (camera._preShakeThisFrame.alpha !== undefined) {
                  camera.alpha = camera._preShakeThisFrame.alpha;
                }
                if (camera._preShakeThisFrame.beta !== undefined) {
                  camera.beta = camera._preShakeThisFrame.beta;
                }
              } else {
                if (camera._preShakeThisFrame.position) {
                  camera.position = camera._preShakeThisFrame.position;
                }
              }
            }
          });
          
          console.log('📹 Camera shake update loop started');
        }
      },
      
      dispose: function() {
        // Remove observers to prevent multiple shake applications
        if (this.beforeRenderObserver && this.scene) {
          this.scene.onBeforeRenderObservable.remove(this.beforeRenderObserver);
          this.beforeRenderObserver = null;
        }
        if (this.afterRenderObserver && this.scene) {
          this.scene.onAfterRenderObservable.remove(this.afterRenderObserver);
          this.afterRenderObserver = null;
        }
        this.cameraShakeTimers.clear();
        console.log('📹 CameraShakeManager disposed');
      }
    };
    
    console.log('📹 CameraShakeManager initialized');
    return manager;
  }

  // Camera Tracking System (exact copy from viewer.js)
  function createCameraTrackingManager(scene, sceneGraph) {
    const manager = {
      scene: scene,
      sceneGraph: sceneGraph,
      trackedCameras: new Map(),
      
      initialize: function() {
        this.scanForTrackingCameras();
        this.setupUpdateLoop();
      },
      
      scanForTrackingCameras: function() {
        if (!this.sceneGraph || !this.sceneGraph.nodes) return;

        let foundCount = 0;

        for (const node of this.sceneGraph.nodes) {
          // Skip deleted objects
          if (node.metadata && node.metadata.deleted === true) continue;
          
          if (node.kind === 'camera' && node.camera && node.camera.targetMode === 'object' && node.camera.targetObject) {
            const babylonCamera = this.scene.getCameraById(node.id);
            const targetObject = this.scene.getNodeById(node.camera.targetObject);
            
            if (babylonCamera && targetObject) {
              this.trackedCameras.set(node.id, {
                camera: babylonCamera,
                targetObjectId: node.camera.targetObject,
                targetObject: targetObject,
                targetOffset: node.camera.targetOffset || [0, 0, 0]
              });
              
              foundCount++;
              console.log('📹 Found camera tracking object: ' + node.name + ' → ' + (targetObject.name || node.camera.targetObject));
            }
          }
        }

        console.log('📹 Found ' + foundCount + ' cameras with object targets');
      },
      
      updateCameraTargets: function() {
        for (const [cameraId, trackingData] of this.trackedCameras) {
          const camera = trackingData.camera;
          const targetObject = trackingData.targetObject;
          const targetOffset = trackingData.targetOffset;
          
          if (camera instanceof BABYLON.ArcRotateCamera && targetObject) {
            // CRITICAL FIX: Use world position to account for parent hierarchy movement
            // When child objects move with their parents (e.g., via input controls), 
            // their local position stays the same but world position changes
            const worldPosition = targetObject.getAbsolutePosition();
            
            // Apply target offset
            const offset = targetOffset || [0, 0, 0];
            camera.target.set(
              worldPosition.x + offset[0],
              worldPosition.y + offset[1],
              worldPosition.z + offset[2]
            );
          }
        }
      },
      
      setupUpdateLoop: function() {
        // Use scene's render loop for smooth camera tracking
        if (this.scene && this.trackedCameras.size > 0) {
          const self = this;
          this.scene.onBeforeRenderObservable.add(function() {
            self.updateCameraTargets();
          });
          console.log('📹 Camera tracking update loop started');
        }
      },
      
      dispose: function() {
        this.trackedCameras.clear();
        console.log('📹 CameraTrackingManager disposed');
      }
    };
    
    console.log('📹 CameraTrackingManager initialized');
    return manager;
  }

  // Ultra-Performant Camera Collision System - Smart, Predictive, Minimal  
  function createCameraCollisionManager(scene, sceneGraph) {
    const manager = {
      scene: scene,
      sceneGraph: sceneGraph,
      collisionCameras: new Map(),
      solidMeshes: [], // Pre-filtered collision meshes
      lastUpdateFrame: 0,
      
      initialize: function() {
        this.buildCollisionMeshCache();
        this.scanForCollisionCameras();
        this.setupSmartUpdateLoop();
      },

      // SMART: Pre-filter and cache only solid meshes once
      buildCollisionMeshCache: function() {
        this.solidMeshes = this.scene.meshes.filter(function(mesh) {
          return mesh?.isPickable === true && 
                 mesh?.metadata?.solid !== false && 
                 mesh.isEnabled() &&
                 mesh.visibility > 0.5 &&
                 mesh.getBoundingInfo()?.boundingBox.vectorsWorld?.length > 0;
        });
        console.log('📹 Cached ' + this.solidMeshes.length + ' collision meshes');
      },
      
      scanForCollisionCameras: function() {
        if (!this.sceneGraph || !this.sceneGraph.nodes) return;

        let foundCount = 0;
        this.collisionCameras.clear();

        for (const node of this.sceneGraph.nodes) {
          if (node.kind === 'camera' && node.camera?.collision?.enabled) {
            const babylonCamera = this.scene.getCameraById(node.id);
            
            if (babylonCamera) {
              // Store both current and desired radius for ArcRotate cameras
              const isArcRotate = babylonCamera instanceof BABYLON.ArcRotateCamera;
              
              this.collisionCameras.set(node.id, {
                camera: babylonCamera,
                settings: node.camera.collision,
                targetNodeId: node.camera.targetObject || null,
                // Smart state tracking
                desiredRadius: isArcRotate ? babylonCamera.radius : null,
                currentRadius: isArcRotate ? babylonCamera.radius : null,
                // Velocity-based prediction
                velocity: new BABYLON.Vector3(0, 0, 0),
                lastPosition: babylonCamera.position.clone(),
                lastTargetPosition: isArcRotate ? babylonCamera.target.clone() : null,
                // Smart collision state
                isColliding: false,
                collisionResult: null,
                lastCheckFrame: 0,
                // Adaptive frequency
                staticFrames: 0,
                updateInterval: 5
              });
              
              // Listen for user zoom changes to update desired radius
              if (isArcRotate) {
                this.setupRadiusTracking(babylonCamera, node.id);
              }
              
              foundCount++;
              console.log('📹 Found camera with collision: ' + node.name);
            }
          }
        }

        console.log('📹 Found ' + foundCount + ' cameras with collision enabled');
      },

      setupRadiusTracking: function(camera, cameraId) {
        // Track when user manually changes radius (zoom)
        let lastRadius = camera.radius;
        const cameraData = this.collisionCameras.get(cameraId);
        const self = this;
        
        // Check for user-initiated radius changes
        const checkRadiusChange = function() {
          if (Math.abs(camera.radius - lastRadius) > 0.1 && !cameraData.isColliding) {
            cameraData.desiredRadius = camera.radius;
            cameraData.staticFrames = 0; // Reset static counter
          }
          lastRadius = camera.radius;
        };
        
        // Listen for wheel events (zoom)
        camera.onProjectionMatrixChangedObservable.add(checkRadiusChange);
      },
      
      getTargetPoint: function(camera, targetNodeId) {
        if (camera instanceof BABYLON.ArcRotateCamera) {
          return camera.target;
        } else if (targetNodeId) {
          const targetObject = this.scene.getNodeById(targetNodeId);
          if (targetObject) {
            return targetObject.getAbsolutePosition();
          }
        }
        
        // Fallback: look ahead from camera position
        return camera.position.add(camera.getDirection(BABYLON.Vector3.Forward()).scale(5));
      },

      // SMART: Only check cameras that actually need it
      needsUpdate: function(cameraData, frameCounter) {
        const camera = cameraData.camera;
        const lastPosition = cameraData.lastPosition;
        const updateInterval = cameraData.updateInterval;
        const staticFrames = cameraData.staticFrames;
        
        // Skip if not time yet (adaptive frequency)
        if (frameCounter - cameraData.lastCheckFrame < updateInterval) return false;
        
        // Calculate velocity for prediction
        const currentPos = camera.position;
        const movement = currentPos.subtract(lastPosition);
        const velocity = movement.length();
        
        // Update velocity vector for prediction
        if (velocity > 0.01) {
          cameraData.velocity = movement.normalize();
          cameraData.staticFrames = 0;
        } else {
          cameraData.staticFrames++;
        }
        
        // Adaptive frequency: slower checks when static
        if (cameraData.staticFrames > 30) {
          cameraData.updateInterval = 15; // Very slow for static cameras
          if (cameraData.staticFrames > 120) return false; // Stop checking completely
        } else if (velocity > 0.5) {
          cameraData.updateInterval = 2; // Fast checks for moving cameras
        } else {
          cameraData.updateInterval = 5; // Normal rate
        }
        
        // Must check if significant movement or collision state change
        return velocity > 0.05 || cameraData.isColliding;
      },

      // SMART: Fast distance pre-check before expensive ray casting
      fastProximityCheck: function(cameraData) {
        const camera = cameraData.camera;
        const settings = cameraData.settings;
        const distance = settings.distance || 10;
        
        const cameraPos = camera.position;
        const maxCheckDistance = distance + 2; // Add buffer
        
        // Quick check: is camera near any solid mesh?
        for (let i = 0; i < this.solidMeshes.length; i++) {
          const mesh = this.solidMeshes[i];
          const meshPos = mesh.getBoundingInfo().boundingBox.centerWorld;
          const meshSize = mesh.getBoundingInfo().boundingBox.maximumWorld.subtract(
            mesh.getBoundingInfo().boundingBox.minimumWorld
          ).length();
          
          const distanceToMesh = cameraPos.subtract(meshPos).length();
          
          // If camera is close enough to any mesh, collision is possible
          if (distanceToMesh < maxCheckDistance + meshSize * 0.5) {
            return true;
          }
        }
        
        return false; // No meshes nearby, skip expensive ray cast
      },

      // SMART: Predictive collision using velocity  
      predictiveCollisionCheck: function(cameraData) {
        const camera = cameraData.camera;
        const settings = cameraData.settings;
        const targetNodeId = cameraData.targetNodeId;
        const distance = settings.distance || 10;
        const cushion = settings.cushion || 0.2;

        // Get the target point
        const targetPoint = this.getTargetPoint(camera, targetNodeId);
        
        // For ArcRotate cameras, use desired radius for collision check
        let checkRadius = distance;
        if (camera instanceof BABYLON.ArcRotateCamera) {
          checkRadius = Math.min(cameraData.desiredRadius, distance);
        }
        
        // Calculate desired camera position
        let desiredPosition;
        
        if (camera instanceof BABYLON.ArcRotateCamera) {
          const alpha = camera.alpha;
          const beta = camera.beta;
          
          desiredPosition = new BABYLON.Vector3(
            targetPoint.x + checkRadius * Math.sin(beta) * Math.cos(alpha),
            targetPoint.y + checkRadius * Math.cos(beta),
            targetPoint.z + checkRadius * Math.sin(beta) * Math.sin(alpha)
          );
        } else {
          const direction = camera.position.subtract(targetPoint);
          const currentDistance = direction.length();
          
          if (currentDistance > distance) {
            direction.normalize();
            desiredPosition = targetPoint.add(direction.scale(distance));
          } else {
            desiredPosition = camera.position.clone();
          }
        }

        // Cast ray from target to desired position
        const rayDirection = desiredPosition.subtract(targetPoint);
        const rayLength = rayDirection.length();
        
        // Skip if ray is too short
        if (rayLength < 0.1) return false;
        
        rayDirection.normalize();
        const ray = new BABYLON.Ray(targetPoint, rayDirection);
        
        // Use cached mesh list instead of scene.pickWithRay for performance
        let closestHit = null;
        let closestDistance = rayLength;
        
        // Check only meshes that could be in the ray path (smart filtering)
        for (let i = 0; i < this.solidMeshes.length; i++) {
          const mesh = this.solidMeshes[i];
          
          // Quick bounding sphere check first
          const meshCenter = mesh.getBoundingInfo().boundingSphere.centerWorld;
          const meshRadius = mesh.getBoundingInfo().boundingSphere.radiusWorld;
          
          // Vector from target to mesh center
          const toMeshCenter = meshCenter.subtract(targetPoint);
          const distanceAlongRay = BABYLON.Vector3.Dot(toMeshCenter, rayDirection);
          
          // Skip if mesh is behind ray or too far
          if (distanceAlongRay < 0 || distanceAlongRay > closestDistance + meshRadius) continue;
          
          // Distance from ray to mesh center
          const rayToMeshCenter = toMeshCenter.subtract(rayDirection.scale(distanceAlongRay));
          const distanceFromRay = rayToMeshCenter.length();
          
          // Skip if ray misses mesh bounding sphere
          if (distanceFromRay > meshRadius) continue;
          
          // Only now do expensive ray-mesh intersection
          const ray = new BABYLON.Ray(targetPoint, rayDirection);
          const hit = ray.intersectsMesh(mesh);
          
          if (hit.hit && hit.distance > 0 && hit.distance < closestDistance) {
            closestHit = hit;
            closestDistance = hit.distance;
          }
        }
        
        const hit = closestHit;
        
        if (hit && hit.distance > 0 && hit.distance < rayLength) {
          // Collision detected
          const collisionDistance = Math.max(0.1, hit.distance - cushion);
          
          if (camera instanceof BABYLON.ArcRotateCamera) {
            // Smooth transition with less computation
            const targetRadius = collisionDistance;
            camera.radius += (targetRadius - camera.radius) * 0.2;
            cameraData.currentRadius = camera.radius;
            cameraData.isColliding = true;
          } else {
            // For Universal cameras
            const finalPosition = targetPoint.add(rayDirection.scale(collisionDistance));
            camera.position.addInPlace(finalPosition.subtract(camera.position).scale(0.1));
            cameraData.isColliding = true;
          }
          
          cameraData.collisionResult = { distance: collisionDistance, point: hit.pickedPoint };
          return true;
        } else {
          // Smart restoration: only if we were colliding
          if (cameraData.isColliding && camera instanceof BABYLON.ArcRotateCamera) {
            const radiusDiff = cameraData.desiredRadius - camera.radius;
            if (Math.abs(radiusDiff) > 0.05) {
              camera.radius += radiusDiff * 0.1;
              cameraData.currentRadius = camera.radius;
            } else {
              camera.radius = cameraData.desiredRadius;
              cameraData.currentRadius = camera.radius;
              cameraData.isColliding = false;
              cameraData.collisionResult = null;
            }
          } else {
            cameraData.isColliding = false;
            cameraData.collisionResult = null;
          }
          
          return false;
        }
      },
      
      updateCamera: function(cameraData, frameCounter) {
        // Smart early exit: skip if no update needed
        if (!this.needsUpdate(cameraData, frameCounter)) return;
        
        // Ultra-fast proximity check: skip expensive operations if no meshes nearby
        if (!this.fastProximityCheck(cameraData)) {
          // No meshes nearby, ensure we're not colliding and exit fast
          if (cameraData.isColliding) {
            cameraData.isColliding = false;
            cameraData.collisionResult = null;
          }
          cameraData.lastCheckFrame = frameCounter;
          return;
        }
        
        // Predictive collision check (only when needed)
        this.predictiveCollisionCheck(cameraData);
        
        // Update tracking data efficiently
        cameraData.lastPosition.copyFrom(cameraData.camera.position);
        if (cameraData.camera instanceof BABYLON.ArcRotateCamera && cameraData.lastTargetPosition) {
          cameraData.lastTargetPosition.copyFrom(cameraData.camera.target);
        }
        cameraData.lastCheckFrame = frameCounter;
      },
      
      smartUpdate: function() {
        this.lastUpdateFrame++;
        
        // Smart: only process cameras that might need updates
        for (const cameraId of this.collisionCameras.keys()) {
          const cameraData = this.collisionCameras.get(cameraId);
          this.updateCamera(cameraData, this.lastUpdateFrame);
        }
      },
      
      setupSmartUpdateLoop: function() {
        if (this.scene && this.collisionCameras.size > 0) {
          const self = this;
          this.scene.onBeforeRenderObservable.add(function() {
            self.smartUpdate();
          });
          console.log('📹 Smart collision loop started - adaptive & predictive');
        }
      },
      
      dispose: function() {
        this.collisionCameras.clear();
        this.solidMeshes = [];
        console.log('📹 Smart CameraCollisionManager disposed');
      }
    };
    
    console.log('📹 CameraCollisionManager initialized');
    return manager;
  }

})();