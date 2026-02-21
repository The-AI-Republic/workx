/**
 * WaterRipple - Vanilla JavaScript water ripple effect
 * Converted from jQuery.ripples to work on full page overlay
 */

class WaterRipple {
    constructor(options = {}) {
        this.config = this._loadConfig();
        if (!this.config) {
            throw new Error('Your browser does not support WebGL, the OES_texture_float extension or rendering to floating point textures.');
        }

        // Default options
        this.options = {
            resolution: options.resolution || 256,
            dropRadius: options.dropRadius || 20,
            perturbance: options.perturbance || 0.045, // Increased 50% for wider spread
            imageUrl: options.imageUrl || null,
            canvasScale: options.canvasScale || 0.5, // Render at 50% resolution for performance
            idleThreshold: options.idleThreshold || 0.002, // Activity threshold for auto-pause
            ...options
        };

        // State
        this.running = false;
        this.visible = false;
        this.destroyed = false;
        this.undulating = false;
        this.undulateStartTime = 0;
        this.updateCounter = 0; // For 50% speed increase (1.5x updates per frame)

        // Performance optimization state
        this.textureBoundariesDirty = true; // Flag to recompute boundaries
        this.cachedTextureBoundaries = null; // Cached boundaries
        this.lastActivity = 0; // Timestamp of last ripple activity
        this.isIdle = true; // Whether simulation has settled
        this.activityLevel = 0; // Current activity level (for auto-pause)

        // Effect duration control (4s active, 5s total fadeout)
        this.effectStartTime = 0; // When current effect sequence started
        this.effectTimeout = null; // Timeout for effect cleanup
        this.isEffectActive = false; // Whether any effect is currently active

        // Undulate effect control
        this.undulateTimeouts = []; // Array of pending undulate timeouts

        // Create overlay canvas
        this._createCanvas();
        this._initWebGL();
        this._initShaders();
        this._initTexture();
        this._setTransparentTexture();

        // Load background image
        this._loadBackgroundImage();

        // Start animation loop
        this._startAnimation();
    }

    _loadBackgroundImage() {
        // Try to get background image from options or from page CSS
        let imageUrl = this.options.imageUrl;

        if (!imageUrl) {
            // Try to extract from body background
            const bodyBg = window.getComputedStyle(document.body).backgroundImage;
            imageUrl = this._extractUrl(bodyBg);

            // If not on body, try html element
            if (!imageUrl) {
                const htmlBg = window.getComputedStyle(document.documentElement).backgroundImage;
                imageUrl = this._extractUrl(htmlBg);
            }
        }

        if (imageUrl) {
            this._loadImage(imageUrl);
        } else {
            // No background image found, use transparent
            this._setTransparentTexture();
        }
    }

    _extractUrl(value) {
        if (!value || value === 'none') {
            return null;
        }
        const urlMatch = /url\(["']?([^"']*)["']?\)/.exec(value);
        return urlMatch ? urlMatch[1] : null;
    }

    _loadConfig() {
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');

        if (!gl) {
            return null;
        }

        // Load extensions
        const extensions = {};
        ['OES_texture_float', 'OES_texture_half_float', 'OES_texture_float_linear', 'OES_texture_half_float_linear']
            .forEach(name => {
                const extension = gl.getExtension(name);
                if (extension) {
                    extensions[name] = extension;
                }
            });

        if (!extensions.OES_texture_float) {
            return null;
        }

        const configs = [];

        const createConfig = (type, glType, arrayType) => {
            const name = 'OES_texture_' + type;
            const nameLinear = name + '_linear';
            const linearSupport = nameLinear in extensions;
            const configExtensions = [name];

            if (linearSupport) {
                configExtensions.push(nameLinear);
            }

            return {
                type: glType,
                arrayType: arrayType,
                linearSupport: linearSupport,
                extensions: configExtensions
            };
        };

        configs.push(createConfig('float', gl.FLOAT, Float32Array));

        if (extensions.OES_texture_half_float) {
            configs.push(
                createConfig('half_float', extensions.OES_texture_half_float.HALF_FLOAT_OES, null)
            );
        }

        // Test rendering to texture
        const texture = gl.createTexture();
        const framebuffer = gl.createFramebuffer();

        gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

        let config = null;

        for (let i = 0; i < configs.length; i++) {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 32, 32, 0, gl.RGBA, configs[i].type, null);
            gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);

            if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE) {
                config = configs[i];
                break;
            }
        }

        return config;
    }

    _createCanvas() {
        // Create overlay canvas
        this.canvas = document.createElement('canvas');
        this.canvas.style.position = 'fixed';
        this.canvas.style.top = '0';
        this.canvas.style.left = '0';
        this.canvas.style.width = '100%';
        this.canvas.style.height = '100%';
        this.canvas.style.pointerEvents = 'none';
        this.canvas.style.zIndex = '9999';
        this.canvas.style.display = 'none';

        document.body.appendChild(this.canvas);

        this._updateSize();

        // Debounced resize handler for performance
        this._resizeTimeout = null;
        this._resizeHandler = () => {
            // Mark boundaries as dirty immediately for next render
            this.textureBoundariesDirty = true;

            // Debounce the actual resize work
            if (this._resizeTimeout) {
                clearTimeout(this._resizeTimeout);
            }
            this._resizeTimeout = setTimeout(() => {
                this._updateSize();
                // Reload background image on resize to maintain quality
                if (this.imageSource) {
                    this._loadImage(this.imageSource);
                }
            }, 150); // Wait 150ms after last resize event
        };
        window.addEventListener('resize', this._resizeHandler, { passive: true });
    }

    _initWebGL() {
        this.gl = this.canvas.getContext('webgl') || this.canvas.getContext('experimental-webgl');

        if (!this.gl) {
            throw new Error('WebGL not supported');
        }

        // Load extensions
        this.config.extensions.forEach(name => {
            this.gl.getExtension(name);
        });

        // Init render targets for ripple data
        this.textures = [];
        this.framebuffers = [];
        this.bufferWriteIndex = 0;
        this.bufferReadIndex = 1;

        const resolution = this.options.resolution;
        const arrayType = this.config.arrayType;
        const textureData = arrayType ? new arrayType(resolution * resolution * 4) : null;

        for (let i = 0; i < 2; i++) {
            const texture = this.gl.createTexture();
            const framebuffer = this.gl.createFramebuffer();

            this.gl.bindFramebuffer(this.gl.FRAMEBUFFER, framebuffer);
            this.gl.bindTexture(this.gl.TEXTURE_2D, texture);

            const filter = this.config.linearSupport ? this.gl.LINEAR : this.gl.NEAREST;
            this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, filter);
            this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, filter);
            this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
            this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
            this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, resolution, resolution, 0, this.gl.RGBA, this.config.type, textureData);

            this.gl.framebufferTexture2D(this.gl.FRAMEBUFFER, this.gl.COLOR_ATTACHMENT0, this.gl.TEXTURE_2D, texture, 0);

            this.textures.push(texture);
            this.framebuffers.push(framebuffer);
        }

        // Create quad buffer
        this.quad = this.gl.createBuffer();
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.quad);
        this.gl.bufferData(this.gl.ARRAY_BUFFER, new Float32Array([
            -1, -1,
            +1, -1,
            +1, +1,
            -1, +1
        ]), this.gl.STATIC_DRAW);

        // Set clear color and blend mode
        this.gl.clearColor(0, 0, 0, 0);
        this.gl.blendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);

        this.textureDelta = new Float32Array([1 / resolution, 1 / resolution]);
    }

    _initShaders() {
        const gl = this.gl;

        const vertexShader = `
            attribute vec2 vertex;
            varying vec2 coord;
            void main() {
                coord = vertex * 0.5 + 0.5;
                gl_Position = vec4(vertex, 0.0, 1.0);
            }
        `;

        // Drop shader
        this.dropProgram = this._createProgram(vertexShader, `
            precision highp float;
            const float PI = 3.141592653589793;
            uniform sampler2D texture;
            uniform vec2 center;
            uniform float radius;
            uniform float strength;
            varying vec2 coord;

            void main() {
                vec4 info = texture2D(texture, coord);
                float drop = max(0.0, 1.0 - length(center * 0.5 + 0.5 - coord) / radius);
                drop = 0.5 - cos(drop * PI) * 0.5;
                info.r += drop * strength;
                gl_FragColor = info;
            }
        `);

        // Update shader - this simulates wave propagation
        this.updateProgram = this._createProgram(vertexShader, `
            precision highp float;
            uniform sampler2D texture;
            uniform vec2 delta;
            varying vec2 coord;

            void main() {
                /* Get the current height and velocity */
                vec4 info = texture2D(texture, coord);

                /* Calculate the average of neighboring heights */
                vec2 dx = vec2(delta.x, 0.0);
                vec2 dy = vec2(0.0, delta.y);

                float average = (
                    texture2D(texture, coord - dx).r +
                    texture2D(texture, coord - dy).r +
                    texture2D(texture, coord + dx).r +
                    texture2D(texture, coord + dy).r
                ) * 0.25;

                /* Apply wave equation: acceleration = average - current */
                /* info.g is the velocity */
                info.g += (average - info.r) * 2.0;

                /* Edge damping to absorb waves at boundaries (prevent bounce-back) */
                /* Calculate distance from edges (0.0 at edge, 1.0 at center) */
                float edgeDistance = min(
                    min(coord.x, 1.0 - coord.x),
                    min(coord.y, 1.0 - coord.y)
                );

                /* Create damping zone near edges (0.05 = 5% of texture size) */
                float edgeDamping = smoothstep(0.0, 0.05, edgeDistance);

                /* Apply stronger damping near edges */
                float damping = mix(0.85, 0.995, edgeDamping);
                info.g *= damping;

                /* Apply velocity to height */
                info.r += info.g;

                gl_FragColor = info;
            }
        `);
        gl.uniform2fv(this.updateProgram.locations.delta, this.textureDelta);

        // Render shader
        this.renderProgram = this._createProgram(`
            precision highp float;
            attribute vec2 vertex;
            uniform vec2 topLeft;
            uniform vec2 bottomRight;
            uniform vec2 containerRatio;
            varying vec2 ripplesCoord;
            varying vec2 backgroundCoord;

            void main() {
                backgroundCoord = mix(topLeft, bottomRight, vertex * 0.5 + 0.5);
                backgroundCoord.y = 1.0 - backgroundCoord.y;
                ripplesCoord = vec2(vertex.x, -vertex.y) * containerRatio * 0.5 + 0.5;
                gl_Position = vec4(vertex.x, -vertex.y, 0.0, 1.0);
            }
        `, `
            precision highp float;
            uniform sampler2D samplerBackground;
            uniform sampler2D samplerRipples;
            uniform vec2 delta;
            uniform float perturbance;
            varying vec2 ripplesCoord;
            varying vec2 backgroundCoord;

            void main() {
                float height = texture2D(samplerRipples, ripplesCoord).r;
                float heightX = texture2D(samplerRipples, vec2(ripplesCoord.x + delta.x, ripplesCoord.y)).r;
                float heightY = texture2D(samplerRipples, vec2(ripplesCoord.x, ripplesCoord.y + delta.y)).r;
                vec3 dx = vec3(delta.x, heightX - height, 0.0);
                vec3 dy = vec3(0.0, heightY - height, delta.y);
                vec2 offset = -normalize(cross(dy, dx)).xz;

                // Enhanced specular for bright white glowing effect (like sunshine on water)
                float specular = pow(max(0.0, dot(offset, normalize(vec2(-0.6, 1.0)))), 8.0);

                // Get background color with distortion
                vec4 bgColor = texture2D(samplerBackground, backgroundCoord + offset * perturbance);

                // Add shadow (darken areas where water dips)
                float shadow = smoothstep(-0.02, 0.02, height) * 0.15;
                bgColor.rgb *= (1.0 - shadow);

                // Add bright white glow to specular highlights (2.5x brighter)
                vec3 sunlight = vec3(1.0, 1.0, 0.98); // Slightly warm white for sunshine
                gl_FragColor = bgColor + vec4(sunlight * specular * 2.5, specular);
            }
        `);
        gl.uniform2fv(this.renderProgram.locations.delta, this.textureDelta);

        this.renderProgram.uniforms = {
            topLeft: new Float32Array([0, 0]),
            bottomRight: new Float32Array([1, 1]),
            containerRatio: new Float32Array([1, 1])
        };
    }

    _createProgram(vertexSource, fragmentSource) {
        const gl = this.gl;

        const compileShader = (type, source) => {
            const shader = gl.createShader(type);
            gl.shaderSource(shader, source);
            gl.compileShader(shader);
            if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
                throw new Error('Shader compile error: ' + gl.getShaderInfoLog(shader));
            }
            return shader;
        };

        const program = {};
        program.id = gl.createProgram();
        gl.attachShader(program.id, compileShader(gl.VERTEX_SHADER, vertexSource));
        gl.attachShader(program.id, compileShader(gl.FRAGMENT_SHADER, fragmentSource));
        gl.linkProgram(program.id);

        if (!gl.getProgramParameter(program.id, gl.LINK_STATUS)) {
            throw new Error('Program link error: ' + gl.getProgramInfoLog(program.id));
        }

        program.uniforms = {};
        program.locations = {};
        gl.useProgram(program.id);
        gl.enableVertexAttribArray(0);

        const regex = /uniform (\w+) (\w+)/g;
        const shaderCode = vertexSource + fragmentSource;
        let match;

        while ((match = regex.exec(shaderCode)) !== null) {
            const name = match[2];
            program.locations[name] = gl.getUniformLocation(program.id, name);
        }

        return program;
    }

    _initTexture() {
        this.backgroundTexture = this.gl.createTexture();
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.backgroundTexture);
        this.gl.pixelStorei(this.gl.UNPACK_FLIP_Y_WEBGL, 1);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
        this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);
    }

    _setTransparentTexture() {
        const transparentPixels = this._createImageData(32, 32);
        this.gl.bindTexture(this.gl.TEXTURE_2D, this.backgroundTexture);
        this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.gl.RGBA, this.gl.UNSIGNED_BYTE, transparentPixels);
    }

    _createImageData(width, height) {
        try {
            return new ImageData(width, height);
        } catch (e) {
            const canvas = document.createElement('canvas');
            return canvas.getContext('2d').createImageData(width, height);
        }
    }

    _loadImage(url) {
        this.imageSource = url;

        const image = new Image();
        image.crossOrigin = 'anonymous';

        image.onload = () => {
            const isPowerOfTwo = (x) => (x & (x - 1)) === 0;
            const wrapping = (isPowerOfTwo(image.width) && isPowerOfTwo(image.height))
                ? this.gl.REPEAT
                : this.gl.CLAMP_TO_EDGE;

            this.gl.bindTexture(this.gl.TEXTURE_2D, this.backgroundTexture);
            this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, wrapping);
            this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, wrapping);
            this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.gl.RGBA, this.gl.UNSIGNED_BYTE, image);

            this.backgroundWidth = image.width;
            this.backgroundHeight = image.height;

            // Store background size and position from CSS
            this.backgroundSize = window.getComputedStyle(document.body).backgroundSize || 'cover';
            this.backgroundPosition = window.getComputedStyle(document.body).backgroundPosition || 'center center';
            this.backgroundAttachment = window.getComputedStyle(document.body).backgroundAttachment || 'scroll';
        };

        image.onerror = () => {
            this._setTransparentTexture();
        };

        image.src = url;
    }

    _updateSize() {
        // Use scaled resolution for better performance
        // CSS will scale it up to full size
        const scale = this.options.canvasScale;
        this.canvas.width = Math.floor(window.innerWidth * scale);
        this.canvas.height = Math.floor(window.innerHeight * scale);

        // Mark boundaries as dirty after resize
        this.textureBoundariesDirty = true;
    }

    _startAnimation() {
        const animate = () => {
            if (!this.destroyed) {
                this._step();
                requestAnimationFrame(animate);
            }
        };
        requestAnimationFrame(animate);
    }

    _step() {
        if (!this.visible) {
            return;
        }

        // Check if effect has exceeded 4 seconds - start aggressive fadeout
        const effectElapsed = performance.now() - this.effectStartTime;
        const inFadeoutPhase = this.isEffectActive && effectElapsed > 4000;

        // Only recompute texture boundaries when needed (performance optimization)
        if (this.textureBoundariesDirty) {
            this._computeTextureBoundaries();
            this.textureBoundariesDirty = false;
        }

        // Update ripple simulation if there's activity or in fadeout phase
        if ((this.running || this.undulating || inFadeoutPhase) && this.isEffectActive) {
            this._update(inFadeoutPhase);

            // Check activity level to determine if we can go idle
            this._updateActivityLevel();
        }

        // Only render if effect is active
        if (this.isEffectActive) {
            this._render();
        }
    }

    _computeTextureBoundaries() {
        if (!this.backgroundWidth || !this.backgroundHeight) {
            // No background loaded yet
            const maxSide = Math.max(this.canvas.width, this.canvas.height);
            this.renderProgram.uniforms.topLeft[0] = 0;
            this.renderProgram.uniforms.topLeft[1] = 0;
            this.renderProgram.uniforms.bottomRight[0] = 1;
            this.renderProgram.uniforms.bottomRight[1] = 1;
            this.renderProgram.uniforms.containerRatio[0] = this.canvas.width / maxSide;
            this.renderProgram.uniforms.containerRatio[1] = this.canvas.height / maxSide;
            return;
        }

        const backgroundSize = this.backgroundSize || 'cover';
        const backgroundPosition = this._translateBackgroundPosition(this.backgroundPosition || 'center center');
        const backgroundAttachment = this.backgroundAttachment || 'scroll';

        // Container is the viewport for fixed attachment, or the canvas for scroll
        const container = {
            left: backgroundAttachment === 'fixed' ? window.pageXOffset : 0,
            top: backgroundAttachment === 'fixed' ? window.pageYOffset : 0,
            width: window.innerWidth,
            height: window.innerHeight
        };

        let backgroundWidth, backgroundHeight;

        // Calculate background dimensions based on background-size
        if (backgroundSize === 'cover') {
            const scale = Math.max(container.width / this.backgroundWidth, container.height / this.backgroundHeight);
            backgroundWidth = this.backgroundWidth * scale;
            backgroundHeight = this.backgroundHeight * scale;
        } else if (backgroundSize === 'contain') {
            const scale = Math.min(container.width / this.backgroundWidth, container.height / this.backgroundHeight);
            backgroundWidth = this.backgroundWidth * scale;
            backgroundHeight = this.backgroundHeight * scale;
        } else {
            const sizes = backgroundSize.split(' ');
            let bgWidth = sizes[0] || '';
            let bgHeight = sizes[1] || bgWidth;

            if (this._isPercentage(bgWidth)) {
                backgroundWidth = container.width * parseFloat(bgWidth) / 100;
            } else if (bgWidth !== 'auto') {
                backgroundWidth = parseFloat(bgWidth);
            }

            if (this._isPercentage(bgHeight)) {
                backgroundHeight = container.height * parseFloat(bgHeight) / 100;
            } else if (bgHeight !== 'auto') {
                backgroundHeight = parseFloat(bgHeight);
            }

            if (bgWidth === 'auto' && bgHeight === 'auto') {
                backgroundWidth = this.backgroundWidth;
                backgroundHeight = this.backgroundHeight;
            } else {
                if (bgWidth === 'auto') {
                    backgroundWidth = this.backgroundWidth * (backgroundHeight / this.backgroundHeight);
                }
                if (bgHeight === 'auto') {
                    backgroundHeight = this.backgroundHeight * (backgroundWidth / this.backgroundWidth);
                }
            }
        }

        // Calculate background position
        let backgroundX = backgroundPosition[0];
        let backgroundY = backgroundPosition[1];

        if (this._isPercentage(backgroundX)) {
            backgroundX = container.left + (container.width - backgroundWidth) * parseFloat(backgroundX) / 100;
        } else {
            backgroundX = container.left + parseFloat(backgroundX);
        }

        if (this._isPercentage(backgroundY)) {
            backgroundY = container.top + (container.height - backgroundHeight) * parseFloat(backgroundY) / 100;
        } else {
            backgroundY = container.top + parseFloat(backgroundY);
        }

        // Calculate texture coordinates for the canvas
        const canvasOffset = { left: 0, top: 0 };

        this.renderProgram.uniforms.topLeft[0] = (canvasOffset.left - backgroundX) / backgroundWidth;
        this.renderProgram.uniforms.topLeft[1] = (canvasOffset.top - backgroundY) / backgroundHeight;
        this.renderProgram.uniforms.bottomRight[0] = this.renderProgram.uniforms.topLeft[0] + this.canvas.width / backgroundWidth;
        this.renderProgram.uniforms.bottomRight[1] = this.renderProgram.uniforms.topLeft[1] + this.canvas.height / backgroundHeight;

        const maxSide = Math.max(this.canvas.width, this.canvas.height);
        this.renderProgram.uniforms.containerRatio[0] = this.canvas.width / maxSide;
        this.renderProgram.uniforms.containerRatio[1] = this.canvas.height / maxSide;
    }

    _isPercentage(str) {
        return str && str[str.length - 1] === '%';
    }

    _translateBackgroundPosition(value) {
        const parts = value.split(' ');

        if (parts.length === 1) {
            switch (value) {
                case 'center':
                    return ['50%', '50%'];
                case 'top':
                    return ['50%', '0'];
                case 'bottom':
                    return ['50%', '100%'];
                case 'left':
                    return ['0', '50%'];
                case 'right':
                    return ['100%', '50%'];
                default:
                    return [value, '50%'];
            }
        } else {
            return parts.map(part => {
                switch (part) {
                    case 'center':
                        return '50%';
                    case 'top':
                    case 'left':
                        return '0';
                    case 'right':
                    case 'bottom':
                        return '100%';
                    default:
                        return part;
                }
            });
        }
    }

    _drawQuad() {
        this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.quad);
        this.gl.vertexAttribPointer(0, 2, this.gl.FLOAT, false, 0, 0);
        this.gl.drawArrays(this.gl.TRIANGLE_FAN, 0, 4);
    }

    _render() {
        const gl = this.gl;

        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        gl.enable(gl.BLEND);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

        gl.useProgram(this.renderProgram.id);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.backgroundTexture);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.textures[0]);

        gl.uniform1f(this.renderProgram.locations.perturbance, this.options.perturbance);
        gl.uniform2fv(this.renderProgram.locations.topLeft, this.renderProgram.uniforms.topLeft);
        gl.uniform2fv(this.renderProgram.locations.bottomRight, this.renderProgram.uniforms.bottomRight);
        gl.uniform2fv(this.renderProgram.locations.containerRatio, this.renderProgram.uniforms.containerRatio);
        gl.uniform1i(this.renderProgram.locations.samplerBackground, 0);
        gl.uniform1i(this.renderProgram.locations.samplerRipples, 1);

        this._drawQuad();
        gl.disable(gl.BLEND);
    }

    _update(inFadeoutPhase = false) {
        const gl = this.gl;

        gl.viewport(0, 0, this.options.resolution, this.options.resolution);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffers[this.bufferWriteIndex]);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.textures[this.bufferReadIndex]);

        gl.useProgram(this.updateProgram.id);
        this._drawQuad();
        this._swapBufferIndices();
    }

    _swapBufferIndices() {
        this.bufferWriteIndex = 1 - this.bufferWriteIndex;
        this.bufferReadIndex = 1 - this.bufferReadIndex;
    }

    /**
     * Start a new effect sequence
     * Sets up 5-second timeout to clear effect after completion
     */
    _startEffect() {
        // Clear any existing timeout
        if (this.effectTimeout) {
            clearTimeout(this.effectTimeout);
        }

        // Mark effect as active
        this.isEffectActive = true;
        this.effectStartTime = performance.now();
        this.isIdle = false;
        this.lastActivity = performance.now();

        // Set 5-second timeout to clear effect
        this.effectTimeout = setTimeout(() => {
            this._clearEffect();
        }, 5000);

        console.debug('[WaterRipple] Effect started, will clear in 5 seconds');
    }

    /**
     * Clear the effect and stop rendering
     * Called after 5-second effect duration
     */
    _clearEffect() {
        const gl = this.gl;

        // Clear the ripple textures to reset simulation
        const resolution = this.options.resolution;
        const arrayType = this.config.arrayType;
        const textureData = arrayType ? new arrayType(resolution * resolution * 4) : null;

        for (let i = 0; i < 2; i++) {
            gl.bindTexture(gl.TEXTURE_2D, this.textures[i]);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, resolution, resolution, 0, gl.RGBA, this.config.type, textureData);
        }

        // Mark effect as inactive
        this.isEffectActive = false;
        this.running = false;
        this.isIdle = true;

        console.debug('[WaterRipple] Effect cleared, rendering stopped');
    }

    /**
     * Update activity level to detect when simulation has settled
     * Reads back a sample of pixels from the ripple texture to measure activity
     */
    _updateActivityLevel() {
        const gl = this.gl;

        // Only check every 10 frames for performance
        if (this.updateCounter % 10 !== 0) {
            this.updateCounter++;
            return;
        }
        this.updateCounter++;

        // Read a small sample from the center of the texture
        const sampleSize = 16; // 16x16 pixel sample
        const resolution = this.options.resolution;
        const centerX = Math.floor((resolution - sampleSize) / 2);
        const centerY = Math.floor((resolution - sampleSize) / 2);

        const pixels = new Uint8Array(sampleSize * sampleSize * 4);

        gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffers[this.bufferReadIndex]);
        gl.readPixels(centerX, centerY, sampleSize, sampleSize, gl.RGBA, gl.UNSIGNED_BYTE, pixels);

        // Calculate average absolute height (r channel)
        let totalActivity = 0;
        for (let i = 0; i < pixels.length; i += 4) {
            // r channel contains height, centered at 127 (0.5 in 0-1 range)
            const height = Math.abs(pixels[i] - 127) / 127;
            totalActivity += height;
        }

        this.activityLevel = totalActivity / (sampleSize * sampleSize);

        // Mark as idle if activity is below threshold
        const wasIdle = this.isIdle;
        this.isIdle = this.activityLevel < this.options.idleThreshold;

        if (!wasIdle && this.isIdle) {
            console.debug('[WaterRipple] Simulation settled, going idle');
            this.lastActivity = performance.now();
        } else if (!this.isIdle) {
            this.lastActivity = performance.now();
        }
    }

    // Public API

    /**
     * Turn on the ripple effect
     */
    turnOn() {
        this.visible = true;
        this.canvas.style.display = 'block';

        // Don't automatically start effect - wait for drop() or undulate()
    }

    /**
     * Turn off the ripple effect
     */
    turnOff() {
        this.visible = false;
        this.running = false;
        this.canvas.style.display = 'none';

        // Clear any pending effect timeout
        if (this.effectTimeout) {
            clearTimeout(this.effectTimeout);
            this.effectTimeout = null;
        }

        // Clear any pending undulate timeouts
        this.undulateTimeouts.forEach(timeout => clearTimeout(timeout));
        this.undulateTimeouts = [];

        // Mark as inactive
        this.isEffectActive = false;
        this.undulating = false;
    }

    /**
     * Drop a ripple at specific coordinates
     * @param {number} x - X coordinate in pixels
     * @param {number} y - Y coordinate in pixels
     * @param {number} radius - Optional radius (default: dropRadius from options)
     * @param {number} strength - Optional strength (default: 0.14)
     */
    drop(x, y, radius, strength) {
        const gl = this.gl;

        radius = radius || this.options.dropRadius;
        strength = strength !== undefined ? strength : 0.14;

        // Start effect sequence (or extend existing one)
        if (!this.isEffectActive) {
            this._startEffect();
        } else {
            // Extend effect duration by resetting the timeout
            this._startEffect();
        }

        this.running = true;

        // Account for scaled canvas resolution
        const scale = this.options.canvasScale;
        const scaledX = x * scale;
        const scaledY = y * scale;

        const longestSide = Math.max(this.canvas.width, this.canvas.height);
        radius = (radius * scale) / longestSide;

        const dropPosition = new Float32Array([
            (2 * scaledX - this.canvas.width) / longestSide,
            (this.canvas.height - 2 * scaledY) / longestSide
        ]);

        gl.viewport(0, 0, this.options.resolution, this.options.resolution);
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffers[this.bufferWriteIndex]);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.textures[this.bufferReadIndex]);

        gl.useProgram(this.dropProgram.id);
        gl.uniform2fv(this.dropProgram.locations.center, dropPosition);
        gl.uniform1f(this.dropProgram.locations.radius, radius);
        gl.uniform1f(this.dropProgram.locations.strength, strength);

        this._drawQuad();
        this._swapBufferIndices();
    }

    /**
     * Create a one-time burst of random ripples across the page that fade out naturally
     * If already undulating, dismisses the new call (no queuing)
     */
    undulate() {
        // Dismiss new undulate calls if already ongoing (no queuing)
        if (this.undulating) {
            console.debug('[WaterRipple] Undulate already in progress, dismissing new call');
            return;
        }

        // Clear any pending undulate timeouts from previous calls
        this.undulateTimeouts.forEach(timeout => clearTimeout(timeout));
        this.undulateTimeouts = [];

        this.undulating = true;

        if (!this.visible) {
            this.turnOn();
        }

        // Start effect sequence
        this._startEffect();
        this.running = true;

        // Use unscaled coordinates for undulate (already in screen space)
        const width = window.innerWidth;
        const height = window.innerHeight;
        const numRipples = 20;
        const maxDelay = 500; // 0.5 seconds range for staggering

        // Generate random points and trigger them with staggered timing
        for (let i = 0; i < numRipples; i++) {
            const x = Math.random() * width;
            const y = Math.random() * height;
            const delay = Math.random() * maxDelay;
            const radius = 20 + Math.random() * 30; // Random radius between 20-50
            const strength = 0.08 + Math.random() * 0.08; // Random strength between 0.08-0.16

            const timeoutId = setTimeout(() => {
                if (this.undulating && this.isEffectActive) {
                    this.drop(x, y, radius, strength);
                }
            }, delay);

            this.undulateTimeouts.push(timeoutId);
        }

        // After all ripples are triggered, mark undulation as complete
        // Effect will be cleared by the 5-second timeout from _startEffect()
        const completionTimeoutId = setTimeout(() => {
            this.undulating = false;
            console.debug('[WaterRipple] Undulate sequence complete');
        }, maxDelay + 100); // Wait for all ripples to trigger + small buffer

        this.undulateTimeouts.push(completionTimeoutId);
    }

    /**
     * Destroy the ripple effect and clean up
     */
    destroy() {
        this.destroyed = true;

        if (this._resizeHandler) {
            window.removeEventListener('resize', this._resizeHandler);
        }

        if (this._resizeTimeout) {
            clearTimeout(this._resizeTimeout);
        }

        if (this.effectTimeout) {
            clearTimeout(this.effectTimeout);
        }

        // Clear all undulate timeouts
        this.undulateTimeouts.forEach(timeout => clearTimeout(timeout));
        this.undulateTimeouts = [];

        if (this.canvas && this.canvas.parentNode) {
            this.canvas.parentNode.removeChild(this.canvas);
        }
    }
}

// Export for use (both CommonJS and ES modules)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = WaterRipple;
}

export default WaterRipple;