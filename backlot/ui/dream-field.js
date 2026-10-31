/*! OGL 1.0.11 from npm, Unlicense. Full original notice: vendor/ogl-evaluation/package/README.md */
(()=>{
const __ogl0=(()=>{

const EPSILON = 0.000001;

/**
 * Calculates the length of a vec3
 *
 * @param {vec3} a vector to calculate length of
 * @returns {Number} length of a
 */
function length(a) {
    let x = a[0];
    let y = a[1];
    let z = a[2];
    return Math.sqrt(x * x + y * y + z * z);
}

/**
 * Copy the values from one vec3 to another
 *
 * @param {vec3} out the receiving vector
 * @param {vec3} a the source vector
 * @returns {vec3} out
 */
function copy(out, a) {
    out[0] = a[0];
    out[1] = a[1];
    out[2] = a[2];
    return out;
}

/**
 * Set the components of a vec3 to the given values
 *
 * @param {vec3} out the receiving vector
 * @param {Number} x X component
 * @param {Number} y Y component
 * @param {Number} z Z component
 * @returns {vec3} out
 */
function set(out, x, y, z) {
    out[0] = x;
    out[1] = y;
    out[2] = z;
    return out;
}

/**
 * Adds two vec3's
 *
 * @param {vec3} out the receiving vector
 * @param {vec3} a the first operand
 * @param {vec3} b the second operand
 * @returns {vec3} out
 */
function add(out, a, b) {
    out[0] = a[0] + b[0];
    out[1] = a[1] + b[1];
    out[2] = a[2] + b[2];
    return out;
}

/**
 * Subtracts vector b from vector a
 *
 * @param {vec3} out the receiving vector
 * @param {vec3} a the first operand
 * @param {vec3} b the second operand
 * @returns {vec3} out
 */
function subtract(out, a, b) {
    out[0] = a[0] - b[0];
    out[1] = a[1] - b[1];
    out[2] = a[2] - b[2];
    return out;
}

/**
 * Multiplies two vec3's
 *
 * @param {vec3} out the receiving vector
 * @param {vec3} a the first operand
 * @param {vec3} b the second operand
 * @returns {vec3} out
 */
function multiply(out, a, b) {
    out[0] = a[0] * b[0];
    out[1] = a[1] * b[1];
    out[2] = a[2] * b[2];
    return out;
}

/**
 * Divides two vec3's
 *
 * @param {vec3} out the receiving vector
 * @param {vec3} a the first operand
 * @param {vec3} b the second operand
 * @returns {vec3} out
 */
function divide(out, a, b) {
    out[0] = a[0] / b[0];
    out[1] = a[1] / b[1];
    out[2] = a[2] / b[2];
    return out;
}

/**
 * Scales a vec3 by a scalar number
 *
 * @param {vec3} out the receiving vector
 * @param {vec3} a the vector to scale
 * @param {Number} b amount to scale the vector by
 * @returns {vec3} out
 */
function scale(out, a, b) {
    out[0] = a[0] * b;
    out[1] = a[1] * b;
    out[2] = a[2] * b;
    return out;
}

/**
 * Calculates the euclidian distance between two vec3's
 *
 * @param {vec3} a the first operand
 * @param {vec3} b the second operand
 * @returns {Number} distance between a and b
 */
function distance(a, b) {
    let x = b[0] - a[0];
    let y = b[1] - a[1];
    let z = b[2] - a[2];
    return Math.sqrt(x * x + y * y + z * z);
}

/**
 * Calculates the squared euclidian distance between two vec3's
 *
 * @param {vec3} a the first operand
 * @param {vec3} b the second operand
 * @returns {Number} squared distance between a and b
 */
function squaredDistance(a, b) {
    let x = b[0] - a[0];
    let y = b[1] - a[1];
    let z = b[2] - a[2];
    return x * x + y * y + z * z;
}

/**
 * Calculates the squared length of a vec3
 *
 * @param {vec3} a vector to calculate squared length of
 * @returns {Number} squared length of a
 */
function squaredLength(a) {
    let x = a[0];
    let y = a[1];
    let z = a[2];
    return x * x + y * y + z * z;
}

/**
 * Negates the components of a vec3
 *
 * @param {vec3} out the receiving vector
 * @param {vec3} a vector to negate
 * @returns {vec3} out
 */
function negate(out, a) {
    out[0] = -a[0];
    out[1] = -a[1];
    out[2] = -a[2];
    return out;
}

/**
 * Returns the inverse of the components of a vec3
 *
 * @param {vec3} out the receiving vector
 * @param {vec3} a vector to invert
 * @returns {vec3} out
 */
function inverse(out, a) {
    out[0] = 1.0 / a[0];
    out[1] = 1.0 / a[1];
    out[2] = 1.0 / a[2];
    return out;
}

/**
 * Normalize a vec3
 *
 * @param {vec3} out the receiving vector
 * @param {vec3} a vector to normalize
 * @returns {vec3} out
 */
function normalize(out, a) {
    let x = a[0];
    let y = a[1];
    let z = a[2];
    let len = x * x + y * y + z * z;
    if (len > 0) {
        //TODO: evaluate use of glm_invsqrt here?
        len = 1 / Math.sqrt(len);
    }
    out[0] = a[0] * len;
    out[1] = a[1] * len;
    out[2] = a[2] * len;
    return out;
}

/**
 * Calculates the dot product of two vec3's
 *
 * @param {vec3} a the first operand
 * @param {vec3} b the second operand
 * @returns {Number} dot product of a and b
 */
function dot(a, b) {
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/**
 * Computes the cross product of two vec3's
 *
 * @param {vec3} out the receiving vector
 * @param {vec3} a the first operand
 * @param {vec3} b the second operand
 * @returns {vec3} out
 */
function cross(out, a, b) {
    let ax = a[0],
        ay = a[1],
        az = a[2];
    let bx = b[0],
        by = b[1],
        bz = b[2];

    out[0] = ay * bz - az * by;
    out[1] = az * bx - ax * bz;
    out[2] = ax * by - ay * bx;
    return out;
}

/**
 * Performs a linear interpolation between two vec3's
 *
 * @param {vec3} out the receiving vector
 * @param {vec3} a the first operand
 * @param {vec3} b the second operand
 * @param {Number} t interpolation amount between the two inputs
 * @returns {vec3} out
 */
function lerp(out, a, b, t) {
    let ax = a[0];
    let ay = a[1];
    let az = a[2];
    out[0] = ax + t * (b[0] - ax);
    out[1] = ay + t * (b[1] - ay);
    out[2] = az + t * (b[2] - az);
    return out;
}

/**
 * Performs a frame rate independant, linear interpolation between two vec3's
 *
 * @param {vec3} out the receiving vector
 * @param {vec3} a the first operand
 * @param {vec3} b the second operand
 * @param {Number} decay decay constant for interpolation. useful range between 1 and 25, from slow to fast.
 * @param {Number} dt delta time
 * @returns {vec3} out
 */
function smoothLerp(out, a, b, decay, dt) {
    const exp = Math.exp(-decay * dt);
    let ax = a[0];
    let ay = a[1];
    let az = a[2];

    out[0] = b[0] + (ax - b[0]) * exp;
    out[1] = b[1] + (ay - b[1]) * exp;
    out[2] = b[2] + (az - b[2]) * exp;
    return out;
}

/**
 * Transforms the vec3 with a mat4.
 * 4th vector component is implicitly '1'
 *
 * @param {vec3} out the receiving vector
 * @param {vec3} a the vector to transform
 * @param {mat4} m matrix to transform with
 * @returns {vec3} out
 */
function transformMat4(out, a, m) {
    let x = a[0],
        y = a[1],
        z = a[2];
    let w = m[3] * x + m[7] * y + m[11] * z + m[15];
    w = w || 1.0;
    out[0] = (m[0] * x + m[4] * y + m[8] * z + m[12]) / w;
    out[1] = (m[1] * x + m[5] * y + m[9] * z + m[13]) / w;
    out[2] = (m[2] * x + m[6] * y + m[10] * z + m[14]) / w;
    return out;
}

/**
 * Same as above but doesn't apply translation.
 * Useful for rays.
 */
function scaleRotateMat4(out, a, m) {
    let x = a[0],
        y = a[1],
        z = a[2];
    let w = m[3] * x + m[7] * y + m[11] * z + m[15];
    w = w || 1.0;
    out[0] = (m[0] * x + m[4] * y + m[8] * z) / w;
    out[1] = (m[1] * x + m[5] * y + m[9] * z) / w;
    out[2] = (m[2] * x + m[6] * y + m[10] * z) / w;
    return out;
}

/**
 * Transforms the vec3 with a mat3.
 *
 * @param {vec3} out the receiving vector
 * @param {vec3} a the vector to transform
 * @param {mat3} m the 3x3 matrix to transform with
 * @returns {vec3} out
 */
function transformMat3(out, a, m) {
    let x = a[0],
        y = a[1],
        z = a[2];
    out[0] = x * m[0] + y * m[3] + z * m[6];
    out[1] = x * m[1] + y * m[4] + z * m[7];
    out[2] = x * m[2] + y * m[5] + z * m[8];
    return out;
}

/**
 * Transforms the vec3 with a quat
 *
 * @param {vec3} out the receiving vector
 * @param {vec3} a the vector to transform
 * @param {quat} q quaternion to transform with
 * @returns {vec3} out
 */
function transformQuat(out, a, q) {
    // benchmarks: https://jsperf.com/quaternion-transform-vec3-implementations-fixed

    let x = a[0],
        y = a[1],
        z = a[2];
    let qx = q[0],
        qy = q[1],
        qz = q[2],
        qw = q[3];

    let uvx = qy * z - qz * y;
    let uvy = qz * x - qx * z;
    let uvz = qx * y - qy * x;

    let uuvx = qy * uvz - qz * uvy;
    let uuvy = qz * uvx - qx * uvz;
    let uuvz = qx * uvy - qy * uvx;

    let w2 = qw * 2;
    uvx *= w2;
    uvy *= w2;
    uvz *= w2;

    uuvx *= 2;
    uuvy *= 2;
    uuvz *= 2;

    out[0] = x + uvx + uuvx;
    out[1] = y + uvy + uuvy;
    out[2] = z + uvz + uuvz;
    return out;
}

/**
 * Get the angle between two 3D vectors
 * @param {vec3} a The first operand
 * @param {vec3} b The second operand
 * @returns {Number} The angle in radians
 */
const angle = (function () {
    const tempA = [0, 0, 0];
    const tempB = [0, 0, 0];

    return function (a, b) {
        copy(tempA, a);
        copy(tempB, b);

        normalize(tempA, tempA);
        normalize(tempB, tempB);

        let cosine = dot(tempA, tempB);

        if (cosine > 1.0) {
            return 0;
        } else if (cosine < -1.0) {
            return Math.PI;
        } else {
            return Math.acos(cosine);
        }
    };
})();

/**
 * Returns whether or not the vectors have exactly the same elements in the same position (when compared with ===)
 *
 * @param {vec3} a The first vector.
 * @param {vec3} b The second vector.
 * @returns {Boolean} True if the vectors are equal, false otherwise.
 */
function exactEquals(a, b) {
    return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

return {length,copy,set,add,subtract,multiply,divide,scale,distance,squaredDistance,squaredLength,negate,inverse,normalize,dot,cross,lerp,smoothLerp,transformMat4,scaleRotateMat4,transformMat3,transformQuat,angle,exactEquals};
})();
const __ogl1=(()=>{
const Vec3Func=__ogl0;

class Vec3 extends Array {
    constructor(x = 0, y = x, z = x) {
        super(x, y, z);
        return this;
    }

    get x() {
        return this[0];
    }

    get y() {
        return this[1];
    }

    get z() {
        return this[2];
    }

    set x(v) {
        this[0] = v;
    }

    set y(v) {
        this[1] = v;
    }

    set z(v) {
        this[2] = v;
    }

    set(x, y = x, z = x) {
        if (x.length) return this.copy(x);
        Vec3Func.set(this, x, y, z);
        return this;
    }

    copy(v) {
        Vec3Func.copy(this, v);
        return this;
    }

    add(va, vb) {
        if (vb) Vec3Func.add(this, va, vb);
        else Vec3Func.add(this, this, va);
        return this;
    }

    sub(va, vb) {
        if (vb) Vec3Func.subtract(this, va, vb);
        else Vec3Func.subtract(this, this, va);
        return this;
    }

    multiply(v) {
        if (v.length) Vec3Func.multiply(this, this, v);
        else Vec3Func.scale(this, this, v);
        return this;
    }

    divide(v) {
        if (v.length) Vec3Func.divide(this, this, v);
        else Vec3Func.scale(this, this, 1 / v);
        return this;
    }

    inverse(v = this) {
        Vec3Func.inverse(this, v);
        return this;
    }

    // Can't use 'length' as Array.prototype uses it
    len() {
        return Vec3Func.length(this);
    }

    distance(v) {
        if (v) return Vec3Func.distance(this, v);
        else return Vec3Func.length(this);
    }

    squaredLen() {
        return Vec3Func.squaredLength(this);
    }

    squaredDistance(v) {
        if (v) return Vec3Func.squaredDistance(this, v);
        else return Vec3Func.squaredLength(this);
    }

    negate(v = this) {
        Vec3Func.negate(this, v);
        return this;
    }

    cross(va, vb) {
        if (vb) Vec3Func.cross(this, va, vb);
        else Vec3Func.cross(this, this, va);
        return this;
    }

    scale(v) {
        Vec3Func.scale(this, this, v);
        return this;
    }

    normalize() {
        Vec3Func.normalize(this, this);
        return this;
    }

    dot(v) {
        return Vec3Func.dot(this, v);
    }

    equals(v) {
        return Vec3Func.exactEquals(this, v);
    }

    applyMatrix3(mat3) {
        Vec3Func.transformMat3(this, this, mat3);
        return this;
    }

    applyMatrix4(mat4) {
        Vec3Func.transformMat4(this, this, mat4);
        return this;
    }

    scaleRotateMatrix4(mat4) {
        Vec3Func.scaleRotateMat4(this, this, mat4);
        return this;
    }

    applyQuaternion(q) {
        Vec3Func.transformQuat(this, this, q);
        return this;
    }

    angle(v) {
        return Vec3Func.angle(this, v);
    }

    lerp(v, t) {
        Vec3Func.lerp(this, this, v, t);
        return this;
    }

    smoothLerp(v, decay, dt) {
        Vec3Func.smoothLerp(this, this, v, decay, dt);
        return this;
    }

    clone() {
        return new Vec3(this[0], this[1], this[2]);
    }

    fromArray(a, o = 0) {
        this[0] = a[o];
        this[1] = a[o + 1];
        this[2] = a[o + 2];
        return this;
    }

    toArray(a = [], o = 0) {
        a[o] = this[0];
        a[o + 1] = this[1];
        a[o + 2] = this[2];
        return a;
    }

    transformDirection(mat4) {
        const x = this[0];
        const y = this[1];
        const z = this[2];

        this[0] = mat4[0] * x + mat4[4] * y + mat4[8] * z;
        this[1] = mat4[1] * x + mat4[5] * y + mat4[9] * z;
        this[2] = mat4[2] * x + mat4[6] * y + mat4[10] * z;

        return this.normalize();
    }
}

return {Vec3};
})();
const __ogl2=(()=>{
const { Vec3 }=__ogl1;

// TODO: Handle context loss https://www.khronos.org/webgl/wiki/HandlingContextLost

// Not automatic - devs to use these methods manually
// gl.colorMask( colorMask, colorMask, colorMask, colorMask );
// gl.clearColor( r, g, b, a );
// gl.stencilMask( stencilMask );
// gl.stencilFunc( stencilFunc, stencilRef, stencilMask );
// gl.stencilOp( stencilFail, stencilZFail, stencilZPass );
// gl.clearStencil( stencil );

const tempVec3 = /* @__PURE__ */ new Vec3();
let ID = 1;

class Renderer {
    constructor({
        canvas = document.createElement('canvas'),
        width = 300,
        height = 150,
        dpr = 1,
        alpha = false,
        depth = true,
        stencil = false,
        antialias = false,
        premultipliedAlpha = false,
        preserveDrawingBuffer = false,
        powerPreference = 'default',
        autoClear = true,
        webgl = 2,
    } = {}) {
        const attributes = { alpha, depth, stencil, antialias, premultipliedAlpha, preserveDrawingBuffer, powerPreference };
        this.dpr = dpr;
        this.alpha = alpha;
        this.color = true;
        this.depth = depth;
        this.stencil = stencil;
        this.premultipliedAlpha = premultipliedAlpha;
        this.autoClear = autoClear;
        this.id = ID++;

        // Attempt WebGL2 unless forced to 1, if not supported fallback to WebGL1
        if (webgl === 2) this.gl = canvas.getContext('webgl2', attributes);
        this.isWebgl2 = !!this.gl;
        if (!this.gl) this.gl = canvas.getContext('webgl', attributes);
        if (!this.gl) console.error('unable to create webgl context');

        // Attach renderer to gl so that all classes have access to internal state functions
        this.gl.renderer = this;

        // initialise size values
        this.setSize(width, height);

        // gl state stores to avoid redundant calls on methods used internally
        this.state = {};
        this.state.blendFunc = { src: this.gl.ONE, dst: this.gl.ZERO };
        this.state.blendEquation = { modeRGB: this.gl.FUNC_ADD };
        this.state.cullFace = false;
        this.state.frontFace = this.gl.CCW;
        this.state.depthMask = true;
        this.state.depthFunc = this.gl.LEQUAL;
        this.state.premultiplyAlpha = false;
        this.state.flipY = false;
        this.state.unpackAlignment = 4;
        this.state.framebuffer = null;
        this.state.viewport = { x: 0, y: 0, width: null, height: null };
        this.state.textureUnits = [];
        this.state.activeTextureUnit = 0;
        this.state.boundBuffer = null;
        this.state.uniformLocations = new Map();
        this.state.currentProgram = null;

        // store requested extensions
        this.extensions = {};

        // Initialise extra format types
        if (this.isWebgl2) {
            this.getExtension('EXT_color_buffer_float');
            this.getExtension('OES_texture_float_linear');
        } else {
            this.getExtension('OES_texture_float');
            this.getExtension('OES_texture_float_linear');
            this.getExtension('OES_texture_half_float');
            this.getExtension('OES_texture_half_float_linear');
            this.getExtension('OES_element_index_uint');
            this.getExtension('OES_standard_derivatives');
            this.getExtension('EXT_sRGB');
            this.getExtension('WEBGL_depth_texture');
            this.getExtension('WEBGL_draw_buffers');
        }
        this.getExtension('WEBGL_compressed_texture_astc');
        this.getExtension('EXT_texture_compression_bptc');
        this.getExtension('WEBGL_compressed_texture_s3tc');
        this.getExtension('WEBGL_compressed_texture_etc1');
        this.getExtension('WEBGL_compressed_texture_pvrtc');
        this.getExtension('WEBKIT_WEBGL_compressed_texture_pvrtc');

        // Create method aliases using extension (WebGL1) or native if available (WebGL2)
        this.vertexAttribDivisor = this.getExtension('ANGLE_instanced_arrays', 'vertexAttribDivisor', 'vertexAttribDivisorANGLE');
        this.drawArraysInstanced = this.getExtension('ANGLE_instanced_arrays', 'drawArraysInstanced', 'drawArraysInstancedANGLE');
        this.drawElementsInstanced = this.getExtension('ANGLE_instanced_arrays', 'drawElementsInstanced', 'drawElementsInstancedANGLE');
        this.createVertexArray = this.getExtension('OES_vertex_array_object', 'createVertexArray', 'createVertexArrayOES');
        this.bindVertexArray = this.getExtension('OES_vertex_array_object', 'bindVertexArray', 'bindVertexArrayOES');
        this.deleteVertexArray = this.getExtension('OES_vertex_array_object', 'deleteVertexArray', 'deleteVertexArrayOES');
        this.drawBuffers = this.getExtension('WEBGL_draw_buffers', 'drawBuffers', 'drawBuffersWEBGL');

        // Store device parameters
        this.parameters = {};
        this.parameters.maxTextureUnits = this.gl.getParameter(this.gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS);
        this.parameters.maxAnisotropy = this.getExtension('EXT_texture_filter_anisotropic')
            ? this.gl.getParameter(this.getExtension('EXT_texture_filter_anisotropic').MAX_TEXTURE_MAX_ANISOTROPY_EXT)
            : 0;
    }

    setSize(width, height) {
        this.width = width;
        this.height = height;

        this.gl.canvas.width = width * this.dpr;
        this.gl.canvas.height = height * this.dpr;

        if (!this.gl.canvas.style) return;
        Object.assign(this.gl.canvas.style, {
            width: width + 'px',
            height: height + 'px',
        });
    }

    setViewport(width, height, x = 0, y = 0) {
        if (this.state.viewport.width === width && this.state.viewport.height === height) return;
        this.state.viewport.width = width;
        this.state.viewport.height = height;
        this.state.viewport.x = x;
        this.state.viewport.y = y;
        this.gl.viewport(x, y, width, height);
    }

    setScissor(width, height, x = 0, y = 0) {
        this.gl.scissor(x, y, width, height);
    }

    enable(id) {
        if (this.state[id] === true) return;
        this.gl.enable(id);
        this.state[id] = true;
    }

    disable(id) {
        if (this.state[id] === false) return;
        this.gl.disable(id);
        this.state[id] = false;
    }

    setBlendFunc(src, dst, srcAlpha, dstAlpha) {
        if (
            this.state.blendFunc.src === src &&
            this.state.blendFunc.dst === dst &&
            this.state.blendFunc.srcAlpha === srcAlpha &&
            this.state.blendFunc.dstAlpha === dstAlpha
        )
            return;
        this.state.blendFunc.src = src;
        this.state.blendFunc.dst = dst;
        this.state.blendFunc.srcAlpha = srcAlpha;
        this.state.blendFunc.dstAlpha = dstAlpha;
        if (srcAlpha !== undefined) this.gl.blendFuncSeparate(src, dst, srcAlpha, dstAlpha);
        else this.gl.blendFunc(src, dst);
    }

    setBlendEquation(modeRGB, modeAlpha) {
        modeRGB = modeRGB || this.gl.FUNC_ADD;
        if (this.state.blendEquation.modeRGB === modeRGB && this.state.blendEquation.modeAlpha === modeAlpha) return;
        this.state.blendEquation.modeRGB = modeRGB;
        this.state.blendEquation.modeAlpha = modeAlpha;
        if (modeAlpha !== undefined) this.gl.blendEquationSeparate(modeRGB, modeAlpha);
        else this.gl.blendEquation(modeRGB);
    }

    setCullFace(value) {
        if (this.state.cullFace === value) return;
        this.state.cullFace = value;
        this.gl.cullFace(value);
    }

    setFrontFace(value) {
        if (this.state.frontFace === value) return;
        this.state.frontFace = value;
        this.gl.frontFace(value);
    }

    setDepthMask(value) {
        if (this.state.depthMask === value) return;
        this.state.depthMask = value;
        this.gl.depthMask(value);
    }

    setDepthFunc(value) {
        if (this.state.depthFunc === value) return;
        this.state.depthFunc = value;
        this.gl.depthFunc(value);
    }

    setStencilMask(value) {
        if(this.state.stencilMask === value) return;
        this.state.stencilMask = value;
        this.gl.stencilMask(value)
    }

    setStencilFunc(func, ref, mask) {

        if((this.state.stencilFunc === func) &&
            (this.state.stencilRef === ref) &&
            (this.state.stencilFuncMask === mask)
        ) return;

        this.state.stencilFunc = func || this.gl.ALWAYS;
        this.state.stencilRef = ref || 0;
        this.state.stencilFuncMask = mask || 0;

        this.gl.stencilFunc(func || this.gl.ALWAYS, ref || 0, mask || 0);
    }

    setStencilOp(stencilFail, depthFail, depthPass) {

        if(this.state.stencilFail === stencilFail &&
            this.state.stencilDepthFail === depthFail &&
            this.state.stencilDepthPass === depthPass
        ) return;

        this.state.stencilFail = stencilFail;
        this.state.stencilDepthFail = depthFail;
        this.state.stencilDepthPass = depthPass;
        
        this.gl.stencilOp(stencilFail, depthFail, depthPass);
        
    }

    activeTexture(value) {
        if (this.state.activeTextureUnit === value) return;
        this.state.activeTextureUnit = value;
        this.gl.activeTexture(this.gl.TEXTURE0 + value);
    }

    bindFramebuffer({ target = this.gl.FRAMEBUFFER, buffer = null } = {}) {
        if (this.state.framebuffer === buffer) return;
        this.state.framebuffer = buffer;
        this.gl.bindFramebuffer(target, buffer);
    }

    getExtension(extension, webgl2Func, extFunc) {
        // if webgl2 function supported, return func bound to gl context
        if (webgl2Func && this.gl[webgl2Func]) return this.gl[webgl2Func].bind(this.gl);

        // fetch extension once only
        if (!this.extensions[extension]) {
            this.extensions[extension] = this.gl.getExtension(extension);
        }

        // return extension if no function requested
        if (!webgl2Func) return this.extensions[extension];

        // Return null if extension not supported
        if (!this.extensions[extension]) return null;

        // return extension function, bound to extension
        return this.extensions[extension][extFunc].bind(this.extensions[extension]);
    }

    sortOpaque(a, b) {
        if (a.renderOrder !== b.renderOrder) {
            return a.renderOrder - b.renderOrder;
        } else if (a.program.id !== b.program.id) {
            return a.program.id - b.program.id;
        } else if (a.zDepth !== b.zDepth) {
            return a.zDepth - b.zDepth;
        } else {
            return b.id - a.id;
        }
    }

    sortTransparent(a, b) {
        if (a.renderOrder !== b.renderOrder) {
            return a.renderOrder - b.renderOrder;
        }
        if (a.zDepth !== b.zDepth) {
            return b.zDepth - a.zDepth;
        } else {
            return b.id - a.id;
        }
    }

    sortUI(a, b) {
        if (a.renderOrder !== b.renderOrder) {
            return a.renderOrder - b.renderOrder;
        } else if (a.program.id !== b.program.id) {
            return a.program.id - b.program.id;
        } else {
            return b.id - a.id;
        }
    }

    getRenderList({ scene, camera, frustumCull, sort }) {
        let renderList = [];

        if (camera && frustumCull) camera.updateFrustum();

        // Get visible
        scene.traverse((node) => {
            if (!node.visible) return true;
            if (!node.draw) return;

            if (frustumCull && node.frustumCulled && camera) {
                if (!camera.frustumIntersectsMesh(node)) return;
            }

            renderList.push(node);
        });

        if (sort) {
            const opaque = [];
            const transparent = []; // depthTest true
            const ui = []; // depthTest false

            renderList.forEach((node) => {
                // Split into the 3 render groups
                if (!node.program.transparent) {
                    opaque.push(node);
                } else if (node.program.depthTest) {
                    transparent.push(node);
                } else {
                    ui.push(node);
                }

                node.zDepth = 0;

                // Only calculate z-depth if renderOrder unset and depthTest is true
                if (node.renderOrder !== 0 || !node.program.depthTest || !camera) return;

                // update z-depth
                node.worldMatrix.getTranslation(tempVec3);
                tempVec3.applyMatrix4(camera.projectionViewMatrix);
                node.zDepth = tempVec3.z;
            });

            opaque.sort(this.sortOpaque);
            transparent.sort(this.sortTransparent);
            ui.sort(this.sortUI);

            renderList = opaque.concat(transparent, ui);
        }

        return renderList;
    }

    render({ scene, camera, target = null, update = true, sort = true, frustumCull = true, clear }) {
        if (target === null) {
            // make sure no render target bound so draws to canvas
            this.bindFramebuffer();
            this.setViewport(this.width * this.dpr, this.height * this.dpr);
        } else {
            // bind supplied render target and update viewport
            this.bindFramebuffer(target);
            this.setViewport(target.width, target.height);
        }

        if (clear || (this.autoClear && clear !== false)) {
            // Ensure depth buffer writing is enabled so it can be cleared
            if (this.depth && (!target || target.depth)) {
                this.enable(this.gl.DEPTH_TEST);
                this.setDepthMask(true);
            }

            // Same for stencil
            if(this.stencil || (!target || target.stencil)) {
                this.enable(this.gl.STENCIL_TEST);
                this.setStencilMask(0xff)
            }

            this.gl.clear(
                (this.color ? this.gl.COLOR_BUFFER_BIT : 0) |
                    (this.depth ? this.gl.DEPTH_BUFFER_BIT : 0) |
                    (this.stencil ? this.gl.STENCIL_BUFFER_BIT : 0)
            );
        }

        // updates all scene graph matrices
        if (update) scene.updateMatrixWorld();

        // Update camera separately, in case not in scene graph
        if (camera) camera.updateMatrixWorld();

        // Get render list - entails culling and sorting
        const renderList = this.getRenderList({ scene, camera, frustumCull, sort });

        renderList.forEach((node) => {
            node.draw({ camera });
        });
    }
}

return {Renderer};
})();
const __ogl3=(()=>{

// TODO: upload empty texture if null ? maybe not
// TODO: upload identity matrix if null ?
// TODO: sampler Cube

let ID = 1;

// cache of typed arrays used to flatten uniform arrays
const arrayCacheF32 = {};

class Program {
    constructor(
        gl,
        {
            vertex,
            fragment,
            uniforms = {},

            transparent = false,
            cullFace = gl.BACK,
            frontFace = gl.CCW,
            depthTest = true,
            depthWrite = true,
            depthFunc = gl.LEQUAL,
        } = {}
    ) {
        if (!gl.canvas) console.error('gl not passed as first argument to Program');
        this.gl = gl;
        this.uniforms = uniforms;
        this.id = ID++;

        if (!vertex) console.warn('vertex shader not supplied');
        if (!fragment) console.warn('fragment shader not supplied');

        // Store program state
        this.transparent = transparent;
        this.cullFace = cullFace;
        this.frontFace = frontFace;
        this.depthTest = depthTest;
        this.depthWrite = depthWrite;
        this.depthFunc = depthFunc;
        this.blendFunc = {};
        this.blendEquation = {};
        this.stencilFunc = {};
        this.stencilOp = {}

        // set default blendFunc if transparent flagged
        if (this.transparent && !this.blendFunc.src) {
            if (this.gl.renderer.premultipliedAlpha) this.setBlendFunc(this.gl.ONE, this.gl.ONE_MINUS_SRC_ALPHA);
            else this.setBlendFunc(this.gl.SRC_ALPHA, this.gl.ONE_MINUS_SRC_ALPHA);
        }

        // Create empty shaders and attach to program
        this.vertexShader = gl.createShader(gl.VERTEX_SHADER);
        this.fragmentShader = gl.createShader(gl.FRAGMENT_SHADER);
        this.program = gl.createProgram();
        gl.attachShader(this.program, this.vertexShader);
        gl.attachShader(this.program, this.fragmentShader);

        // Compile shaders with source
        this.setShaders({ vertex, fragment });
    }

    setShaders({ vertex, fragment }) {
        if (vertex) {
            // compile vertex shader and log errors
            this.gl.shaderSource(this.vertexShader, vertex);
            this.gl.compileShader(this.vertexShader);
            if (this.gl.getShaderInfoLog(this.vertexShader) !== '') {
                console.warn(`${this.gl.getShaderInfoLog(this.vertexShader)}\nVertex Shader\n${addLineNumbers(vertex)}`);
            }
        }

        if (fragment) {
            // compile fragment shader and log errors
            this.gl.shaderSource(this.fragmentShader, fragment);
            this.gl.compileShader(this.fragmentShader);
            if (this.gl.getShaderInfoLog(this.fragmentShader) !== '') {
                console.warn(`${this.gl.getShaderInfoLog(this.fragmentShader)}\nFragment Shader\n${addLineNumbers(fragment)}`);
            }
        }

        // compile program and log errors
        this.gl.linkProgram(this.program);
        if (!this.gl.getProgramParameter(this.program, this.gl.LINK_STATUS)) {
            return console.warn(this.gl.getProgramInfoLog(this.program));
        }

        // Get active uniform locations
        this.uniformLocations = new Map();
        let numUniforms = this.gl.getProgramParameter(this.program, this.gl.ACTIVE_UNIFORMS);
        for (let uIndex = 0; uIndex < numUniforms; uIndex++) {
            let uniform = this.gl.getActiveUniform(this.program, uIndex);
            this.uniformLocations.set(uniform, this.gl.getUniformLocation(this.program, uniform.name));

            // split uniforms' names to separate array and struct declarations
            const split = uniform.name.match(/(\w+)/g);

            uniform.uniformName = split[0];
            uniform.nameComponents = split.slice(1);
        }

        // Get active attribute locations
        this.attributeLocations = new Map();
        const locations = [];
        const numAttribs = this.gl.getProgramParameter(this.program, this.gl.ACTIVE_ATTRIBUTES);
        for (let aIndex = 0; aIndex < numAttribs; aIndex++) {
            const attribute = this.gl.getActiveAttrib(this.program, aIndex);
            const location = this.gl.getAttribLocation(this.program, attribute.name);
            // Ignore special built-in inputs. eg gl_VertexID, gl_InstanceID
            if (location === -1) continue;
            locations[location] = attribute.name;
            this.attributeLocations.set(attribute, location);
        }
        this.attributeOrder = locations.join('');
    }

    setBlendFunc(src, dst, srcAlpha, dstAlpha) {
        this.blendFunc.src = src;
        this.blendFunc.dst = dst;
        this.blendFunc.srcAlpha = srcAlpha;
        this.blendFunc.dstAlpha = dstAlpha;
        if (src) this.transparent = true;
    }

    setBlendEquation(modeRGB, modeAlpha) {
        this.blendEquation.modeRGB = modeRGB;
        this.blendEquation.modeAlpha = modeAlpha;
    }

    setStencilFunc(func, ref, mask) {
        this.stencilRef = ref;
        this.stencilFunc.func = func;
        this.stencilFunc.ref = ref;
        this.stencilFunc.mask = mask;
    }

    setStencilOp(stencilFail, depthFail, depthPass) {
        this.stencilOp.stencilFail = stencilFail;
        this.stencilOp.depthFail = depthFail;
        this.stencilOp.depthPass = depthPass;
    }

    applyState() {
        if (this.depthTest) this.gl.renderer.enable(this.gl.DEPTH_TEST);
        else this.gl.renderer.disable(this.gl.DEPTH_TEST);

        if (this.cullFace) this.gl.renderer.enable(this.gl.CULL_FACE);
        else this.gl.renderer.disable(this.gl.CULL_FACE);

        if (this.blendFunc.src) this.gl.renderer.enable(this.gl.BLEND);
        else this.gl.renderer.disable(this.gl.BLEND);

        if (this.cullFace) this.gl.renderer.setCullFace(this.cullFace);
        this.gl.renderer.setFrontFace(this.frontFace);
        this.gl.renderer.setDepthMask(this.depthWrite);
        this.gl.renderer.setDepthFunc(this.depthFunc);
        if (this.blendFunc.src) this.gl.renderer.setBlendFunc(this.blendFunc.src, this.blendFunc.dst, this.blendFunc.srcAlpha, this.blendFunc.dstAlpha);
        this.gl.renderer.setBlendEquation(this.blendEquation.modeRGB, this.blendEquation.modeAlpha);

        if(this.stencilFunc.func || this.stencilOp.stencilFail) this.gl.renderer.enable(this.gl.STENCIL_TEST)
            else this.gl.renderer.disable(this.gl.STENCIL_TEST)

        this.gl.renderer.setStencilFunc(this.stencilFunc.func, this.stencilFunc.ref, this.stencilFunc.mask)
        this.gl.renderer.setStencilOp(this.stencilOp.stencilFail, this.stencilOp.depthFail, this.stencilOp.depthPass)

    }

    use({ flipFaces = false } = {}) {
        let textureUnit = -1;
        const programActive = this.gl.renderer.state.currentProgram === this.id;

        // Avoid gl call if program already in use
        if (!programActive) {
            this.gl.useProgram(this.program);
            this.gl.renderer.state.currentProgram = this.id;
        }

        // Set only the active uniforms found in the shader
        this.uniformLocations.forEach((location, activeUniform) => {
            let uniform = this.uniforms[activeUniform.uniformName];

            for (const component of activeUniform.nameComponents) {
                if (!uniform) break;

                if (component in uniform) {
                    uniform = uniform[component];
                } else if (Array.isArray(uniform.value)) {
                    break;
                } else {
                    uniform = undefined;
                    break;
                }
            }

            if (!uniform) {
                return warn(`Active uniform ${activeUniform.name} has not been supplied`);
            }

            if (uniform && uniform.value === undefined) {
                return warn(`${activeUniform.name} uniform is missing a value parameter`);
            }

            if (uniform.value.texture) {
                textureUnit = textureUnit + 1;

                // Check if texture needs to be updated
                uniform.value.update(textureUnit);
                return setUniform(this.gl, activeUniform.type, location, textureUnit);
            }

            // For texture arrays, set uniform as an array of texture units instead of just one
            if (uniform.value.length && uniform.value[0].texture) {
                const textureUnits = [];
                uniform.value.forEach((value) => {
                    textureUnit = textureUnit + 1;
                    value.update(textureUnit);
                    textureUnits.push(textureUnit);
                });

                return setUniform(this.gl, activeUniform.type, location, textureUnits);
            }

            setUniform(this.gl, activeUniform.type, location, uniform.value);
        });

        this.applyState();
        if (flipFaces) this.gl.renderer.setFrontFace(this.frontFace === this.gl.CCW ? this.gl.CW : this.gl.CCW);
    }

    remove() {
        this.gl.deleteProgram(this.program);
    }
}

function setUniform(gl, type, location, value) {
    value = value.length ? flatten(value) : value;
    const setValue = gl.renderer.state.uniformLocations.get(location);

    // Avoid redundant uniform commands
    if (value.length) {
        if (setValue === undefined || setValue.length !== value.length) {
            // clone array to store as cache
            gl.renderer.state.uniformLocations.set(location, value.slice(0));
        } else {
            if (arraysEqual(setValue, value)) return;

            // Update cached array values
            setValue.set ? setValue.set(value) : setArray(setValue, value);
            gl.renderer.state.uniformLocations.set(location, setValue);
        }
    } else {
        if (setValue === value) return;
        gl.renderer.state.uniformLocations.set(location, value);
    }

    switch (type) {
        case 5126:
            return value.length ? gl.uniform1fv(location, value) : gl.uniform1f(location, value); // FLOAT
        case 35664:
            return gl.uniform2fv(location, value); // FLOAT_VEC2
        case 35665:
            return gl.uniform3fv(location, value); // FLOAT_VEC3
        case 35666:
            return gl.uniform4fv(location, value); // FLOAT_VEC4
        case 35670: // BOOL
        case 5124: // INT
        case 35678: // SAMPLER_2D
        case 36306: // U_SAMPLER_2D
        case 35680: // SAMPLER_CUBE
        case 36289: // SAMPLER_2D_ARRAY
            return value.length ? gl.uniform1iv(location, value) : gl.uniform1i(location, value); // SAMPLER_CUBE
        case 35671: // BOOL_VEC2
        case 35667:
            return gl.uniform2iv(location, value); // INT_VEC2
        case 35672: // BOOL_VEC3
        case 35668:
            return gl.uniform3iv(location, value); // INT_VEC3
        case 35673: // BOOL_VEC4
        case 35669:
            return gl.uniform4iv(location, value); // INT_VEC4
        case 35674:
            return gl.uniformMatrix2fv(location, false, value); // FLOAT_MAT2
        case 35675:
            return gl.uniformMatrix3fv(location, false, value); // FLOAT_MAT3
        case 35676:
            return gl.uniformMatrix4fv(location, false, value); // FLOAT_MAT4
    }
}

function addLineNumbers(string) {
    let lines = string.split('\n');
    for (let i = 0; i < lines.length; i++) {
        lines[i] = i + 1 + ': ' + lines[i];
    }
    return lines.join('\n');
}

function flatten(a) {
    const arrayLen = a.length;
    const valueLen = a[0].length;
    if (valueLen === undefined) return a;
    const length = arrayLen * valueLen;
    let value = arrayCacheF32[length];
    if (!value) arrayCacheF32[length] = value = new Float32Array(length);
    for (let i = 0; i < arrayLen; i++) value.set(a[i], i * valueLen);
    return value;
}

function arraysEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0, l = a.length; i < l; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}

function setArray(a, b) {
    for (let i = 0, l = a.length; i < l; i++) {
        a[i] = b[i];
    }
}

let warnCount = 0;
function warn(message) {
    if (warnCount > 100) return;
    console.warn(message);
    warnCount++;
    if (warnCount > 100) console.warn('More than 100 program warnings - stopping logs.');
}

return {Program};
})();
const __ogl4=(()=>{

// TODO: delete texture
// TODO: use texSubImage2D for updates (video or when loaded)
// TODO: need? encoding = linearEncoding
// TODO: support non-compressed mipmaps uploads

const emptyPixel = new Uint8Array(4);

function isPowerOf2(value) {
    return (value & (value - 1)) === 0;
}

let ID = 1;

class Texture {
    constructor(
        gl,
        {
            image,
            target = gl.TEXTURE_2D,
            type = gl.UNSIGNED_BYTE,
            format = gl.RGBA,
            internalFormat = format,
            wrapS = gl.CLAMP_TO_EDGE,
            wrapT = gl.CLAMP_TO_EDGE,
            wrapR = gl.CLAMP_TO_EDGE,
            generateMipmaps = target === (gl.TEXTURE_2D || gl.TEXTURE_CUBE_MAP),
            minFilter = generateMipmaps ? gl.NEAREST_MIPMAP_LINEAR : gl.LINEAR,
            magFilter = gl.LINEAR,
            premultiplyAlpha = false,
            unpackAlignment = 4,
            flipY = target == (gl.TEXTURE_2D || gl.TEXTURE_3D) ? true : false,
            anisotropy = 0,
            level = 0,
            width, // used for RenderTargets or Data Textures
            height = width,
            length = 1,
        } = {}
    ) {
        this.gl = gl;
        this.id = ID++;

        this.image = image;
        this.target = target;
        this.type = type;
        this.format = format;
        this.internalFormat = internalFormat;
        this.minFilter = minFilter;
        this.magFilter = magFilter;
        this.wrapS = wrapS;
        this.wrapT = wrapT;
        this.wrapR = wrapR;
        this.generateMipmaps = generateMipmaps;
        this.premultiplyAlpha = premultiplyAlpha;
        this.unpackAlignment = unpackAlignment;
        this.flipY = flipY;
        this.anisotropy = Math.min(anisotropy, this.gl.renderer.parameters.maxAnisotropy);
        this.level = level;
        this.width = width;
        this.height = height;
        this.length = length;
        this.texture = this.gl.createTexture();

        this.store = {
            image: null,
        };

        // Alias for state store to avoid redundant calls for global state
        this.glState = this.gl.renderer.state;

        // State store to avoid redundant calls for per-texture state
        this.state = {};
        this.state.minFilter = this.gl.NEAREST_MIPMAP_LINEAR;
        this.state.magFilter = this.gl.LINEAR;
        this.state.wrapS = this.gl.REPEAT;
        this.state.wrapT = this.gl.REPEAT;
        this.state.anisotropy = 0;
    }

    bind() {
        // Already bound to active texture unit
        if (this.glState.textureUnits[this.glState.activeTextureUnit] === this.id) return;
        this.gl.bindTexture(this.target, this.texture);
        this.glState.textureUnits[this.glState.activeTextureUnit] = this.id;
    }

    update(textureUnit = 0) {
        const needsUpdate = !(this.image === this.store.image && !this.needsUpdate);

        // Make sure that texture is bound to its texture unit
        if (needsUpdate || this.glState.textureUnits[textureUnit] !== this.id) {
            // set active texture unit to perform texture functions
            this.gl.renderer.activeTexture(textureUnit);
            this.bind();
        }

        if (!needsUpdate) return;
        this.needsUpdate = false;

        if (this.flipY !== this.glState.flipY) {
            this.gl.pixelStorei(this.gl.UNPACK_FLIP_Y_WEBGL, this.flipY);
            this.glState.flipY = this.flipY;
        }

        if (this.premultiplyAlpha !== this.glState.premultiplyAlpha) {
            this.gl.pixelStorei(this.gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, this.premultiplyAlpha);
            this.glState.premultiplyAlpha = this.premultiplyAlpha;
        }

        if (this.unpackAlignment !== this.glState.unpackAlignment) {
            this.gl.pixelStorei(this.gl.UNPACK_ALIGNMENT, this.unpackAlignment);
            this.glState.unpackAlignment = this.unpackAlignment;
        }

        if (this.minFilter !== this.state.minFilter) {
            this.gl.texParameteri(this.target, this.gl.TEXTURE_MIN_FILTER, this.minFilter);
            this.state.minFilter = this.minFilter;
        }

        if (this.magFilter !== this.state.magFilter) {
            this.gl.texParameteri(this.target, this.gl.TEXTURE_MAG_FILTER, this.magFilter);
            this.state.magFilter = this.magFilter;
        }

        if (this.wrapS !== this.state.wrapS) {
            this.gl.texParameteri(this.target, this.gl.TEXTURE_WRAP_S, this.wrapS);
            this.state.wrapS = this.wrapS;
        }

        if (this.wrapT !== this.state.wrapT) {
            this.gl.texParameteri(this.target, this.gl.TEXTURE_WRAP_T, this.wrapT);
            this.state.wrapT = this.wrapT;
        }

        if (this.wrapR !== this.state.wrapR) {
            this.gl.texParameteri(this.target, this.gl.TEXTURE_WRAP_R, this.wrapR);
            this.state.wrapR = this.wrapR;
        }

        if (this.anisotropy && this.anisotropy !== this.state.anisotropy) {
            this.gl.texParameterf(this.target, this.gl.renderer.getExtension('EXT_texture_filter_anisotropic').TEXTURE_MAX_ANISOTROPY_EXT, this.anisotropy);
            this.state.anisotropy = this.anisotropy;
        }

        if (this.image) {
            if (this.image.width) {
                this.width = this.image.width;
                this.height = this.image.height;
            }

            if (this.target === this.gl.TEXTURE_CUBE_MAP) {
                // For cube maps
                for (let i = 0; i < 6; i++) {
                    this.gl.texImage2D(this.gl.TEXTURE_CUBE_MAP_POSITIVE_X + i, this.level, this.internalFormat, this.format, this.type, this.image[i]);
                }
            } else if (ArrayBuffer.isView(this.image)) {
                // Data texture
                if (this.target === this.gl.TEXTURE_2D) {
                    this.gl.texImage2D(this.target, this.level, this.internalFormat, this.width, this.height, 0, this.format, this.type, this.image);
                } else if (this.target === this.gl.TEXTURE_2D_ARRAY || this.target === this.gl.TEXTURE_3D) {
                    this.gl.texImage3D(this.target, this.level, this.internalFormat, this.width, this.height, this.length, 0, this.format, this.type, this.image);
                }
            } else if (this.image.isCompressedTexture) {
                // Compressed texture
                for (let level = 0; level < this.image.length; level++) {
                    this.gl.compressedTexImage2D(this.target, level, this.internalFormat, this.image[level].width, this.image[level].height, 0, this.image[level].data);
                }
            } else {
                // Regular texture
                if (this.target === this.gl.TEXTURE_2D) {
                    this.gl.texImage2D(this.target, this.level, this.internalFormat, this.format, this.type, this.image);
                } else {
                    this.gl.texImage3D(this.target, this.level, this.internalFormat, this.width, this.height, this.length, 0, this.format, this.type, this.image);
                }
            }

            if (this.generateMipmaps) {
                // For WebGL1, if not a power of 2, turn off mips, set wrapping to clamp to edge and minFilter to linear
                if (!this.gl.renderer.isWebgl2 && (!isPowerOf2(this.image.width) || !isPowerOf2(this.image.height))) {
                    this.generateMipmaps = false;
                    this.wrapS = this.wrapT = this.gl.CLAMP_TO_EDGE;
                    this.minFilter = this.gl.LINEAR;
                } else {
                    this.gl.generateMipmap(this.target);
                }
            }

            // Callback for when data is pushed to GPU
            this.onUpdate && this.onUpdate();
        } else {
            if (this.target === this.gl.TEXTURE_CUBE_MAP) {
                // Upload empty pixel for each side while no image to avoid errors while image or video loading
                for (let i = 0; i < 6; i++) {
                    this.gl.texImage2D(this.gl.TEXTURE_CUBE_MAP_POSITIVE_X + i, 0, this.gl.RGBA, 1, 1, 0, this.gl.RGBA, this.gl.UNSIGNED_BYTE, emptyPixel);
                }
            } else if (this.width) {
                // image intentionally left null for RenderTarget
                if (this.target === this.gl.TEXTURE_2D) {
                    this.gl.texImage2D(this.target, this.level, this.internalFormat, this.width, this.height, 0, this.format, this.type, null);
                } else {
                    this.gl.texImage3D(this.target, this.level, this.internalFormat, this.width, this.height, this.length, 0, this.format, this.type, null);
                }
            } else {
                // Upload empty pixel if no image to avoid errors while image or video loading
                this.gl.texImage2D(this.target, 0, this.gl.RGBA, 1, 1, 0, this.gl.RGBA, this.gl.UNSIGNED_BYTE, emptyPixel);
            }
        }
        this.store.image = this.image;
    }
}

return {Texture};
})();
const __ogl5=(()=>{
const { Texture }=__ogl4;

class RenderTarget {
    constructor(
        gl,
        {
            width = gl.canvas.width,
            height = gl.canvas.height,
            target = gl.FRAMEBUFFER,
            color = 1, // number of color attachments
            depth = true,
            stencil = false,
            depthTexture = false,
            wrapS = gl.CLAMP_TO_EDGE,
            wrapT = gl.CLAMP_TO_EDGE,
            wrapR = gl.CLAMP_TO_EDGE,
            minFilter = gl.LINEAR,
            magFilter = minFilter,
            type = gl.UNSIGNED_BYTE,
            format = gl.RGBA,
            internalFormat = format,
            unpackAlignment,
            premultiplyAlpha,
        } = {}
    ) {
        this.gl = gl;
        this.width = width;
        this.height = height;
        this.depth = depth;
        this.stencil = stencil;
        this.buffer = this.gl.createFramebuffer();
        this.target = target;
        this.gl.renderer.bindFramebuffer(this);

        this.textures = [];
        const drawBuffers = [];

        // create and attach required num of color textures
        for (let i = 0; i < color; i++) {
            this.textures.push(
                new Texture(gl, {
                    width,
                    height,
                    wrapS,
                    wrapT,
                    wrapR,
                    minFilter,
                    magFilter,
                    type,
                    format,
                    internalFormat,
                    unpackAlignment,
                    premultiplyAlpha,
                    flipY: false,
                    generateMipmaps: false,
                })
            );
            this.textures[i].update();
            this.gl.framebufferTexture2D(this.target, this.gl.COLOR_ATTACHMENT0 + i, this.gl.TEXTURE_2D, this.textures[i].texture, 0 /* level */);
            drawBuffers.push(this.gl.COLOR_ATTACHMENT0 + i);
        }

        // For multi-render targets shader access
        if (drawBuffers.length > 1) this.gl.renderer.drawBuffers(drawBuffers);

        // alias for majority of use cases
        this.texture = this.textures[0];

        // note depth textures break stencil - so can't use together
        if (depthTexture && (this.gl.renderer.isWebgl2 || this.gl.renderer.getExtension('WEBGL_depth_texture'))) {
            this.depthTexture = new Texture(gl, {
                width,
                height,
                minFilter: this.gl.NEAREST,
                magFilter: this.gl.NEAREST,
                format: this.stencil ? this.gl.DEPTH_STENCIL : this.gl.DEPTH_COMPONENT,
                internalFormat: gl.renderer.isWebgl2 ? (this.stencil ? this.gl.DEPTH24_STENCIL8 : this.gl.DEPTH_COMPONENT16) : this.gl.DEPTH_COMPONENT,
                type: this.stencil ? this.gl.UNSIGNED_INT_24_8 : this.gl.UNSIGNED_INT,
            });
            this.depthTexture.update();
            this.gl.framebufferTexture2D(this.target, this.stencil ? this.gl.DEPTH_STENCIL_ATTACHMENT : this.gl.DEPTH_ATTACHMENT, this.gl.TEXTURE_2D, this.depthTexture.texture, 0 /* level */);
        } else {
            // Render buffers
            if (depth && !stencil) {
                this.depthBuffer = this.gl.createRenderbuffer();
                this.gl.bindRenderbuffer(this.gl.RENDERBUFFER, this.depthBuffer);
                this.gl.renderbufferStorage(this.gl.RENDERBUFFER, this.gl.DEPTH_COMPONENT16, width, height);
                this.gl.framebufferRenderbuffer(this.target, this.gl.DEPTH_ATTACHMENT, this.gl.RENDERBUFFER, this.depthBuffer);
            }

            if (stencil && !depth) {
                this.stencilBuffer = this.gl.createRenderbuffer();
                this.gl.bindRenderbuffer(this.gl.RENDERBUFFER, this.stencilBuffer);
                this.gl.renderbufferStorage(this.gl.RENDERBUFFER, this.gl.STENCIL_INDEX8, width, height);
                this.gl.framebufferRenderbuffer(this.target, this.gl.STENCIL_ATTACHMENT, this.gl.RENDERBUFFER, this.stencilBuffer);
            }

            if (depth && stencil) {
                this.depthStencilBuffer = this.gl.createRenderbuffer();
                this.gl.bindRenderbuffer(this.gl.RENDERBUFFER, this.depthStencilBuffer);
                this.gl.renderbufferStorage(this.gl.RENDERBUFFER, this.gl.DEPTH_STENCIL, width, height);
                this.gl.framebufferRenderbuffer(this.target, this.gl.DEPTH_STENCIL_ATTACHMENT, this.gl.RENDERBUFFER, this.depthStencilBuffer);
            }
        }

        this.gl.renderer.bindFramebuffer({ target: this.target });
    }

    setSize(width, height) {
        if (this.width === width && this.height === height) return;

        this.width = width;
        this.height = height;
        this.gl.renderer.bindFramebuffer(this);

        for (let i = 0; i < this.textures.length; i++) {
            this.textures[i].width = width;
            this.textures[i].height = height;
            this.textures[i].needsUpdate = true;
            this.textures[i].update();
            this.gl.framebufferTexture2D(this.target, this.gl.COLOR_ATTACHMENT0 + i, this.gl.TEXTURE_2D, this.textures[i].texture, 0 /* level */);
        }

        if (this.depthTexture) {
            this.depthTexture.width = width;
            this.depthTexture.height = height;
            this.depthTexture.needsUpdate = true;
            this.depthTexture.update();
            this.gl.framebufferTexture2D(this.target, this.gl.DEPTH_ATTACHMENT, this.gl.TEXTURE_2D, this.depthTexture.texture, 0 /* level */);
        } else {
            if (this.depthBuffer) {
                this.gl.bindRenderbuffer(this.gl.RENDERBUFFER, this.depthBuffer);
                this.gl.renderbufferStorage(this.gl.RENDERBUFFER, this.gl.DEPTH_COMPONENT16, width, height);
            }

            if (this.stencilBuffer) {
                this.gl.bindRenderbuffer(this.gl.RENDERBUFFER, this.stencilBuffer);
                this.gl.renderbufferStorage(this.gl.RENDERBUFFER, this.gl.STENCIL_INDEX8, width, height);
            }

            if (this.depthStencilBuffer) {
                this.gl.bindRenderbuffer(this.gl.RENDERBUFFER, this.depthStencilBuffer);
                this.gl.renderbufferStorage(this.gl.RENDERBUFFER, this.gl.DEPTH_STENCIL, width, height);
            }
        }

        this.gl.renderer.bindFramebuffer({ target: this.target });
    }
}

return {RenderTarget};
})();
const __ogl6=(()=>{
const { Vec3 }=__ogl1;
// attribute params
// {
//     data - typed array eg UInt16Array for indices, Float32Array
//     size - int default 1
//     instanced - default null. Pass divisor amount
//     type - gl enum default gl.UNSIGNED_SHORT for 'index', gl.FLOAT for others
//     normalized - boolean default false

//     buffer - gl buffer, if buffer exists, don't need to provide data - although needs position data for bounds calculation
//     stride - default 0 - for when passing in buffer
//     offset - default 0 - for when passing in buffer
//     count - default null - for when passing in buffer
//     min - array - for when passing in buffer
//     max - array - for when passing in buffer
// }

// TODO: fit in transform feedback


const tempVec3 = /* @__PURE__ */ new Vec3();

let ID = 1;
let ATTR_ID = 1;

// To stop inifinite warnings
let isBoundsWarned = false;

class Geometry {
    constructor(gl, attributes = {}) {
        if (!gl.canvas) console.error('gl not passed as first argument to Geometry');
        this.gl = gl;
        this.attributes = attributes;
        this.id = ID++;

        // Store one VAO per program attribute locations order
        this.VAOs = {};

        this.drawRange = { start: 0, count: 0 };
        this.instancedCount = 0;

        // Unbind current VAO so that new buffers don't get added to active mesh
        this.gl.renderer.bindVertexArray(null);
        this.gl.renderer.currentGeometry = null;

        // Alias for state store to avoid redundant calls for global state
        this.glState = this.gl.renderer.state;

        // create the buffers
        for (let key in attributes) {
            this.addAttribute(key, attributes[key]);
        }
    }

    addAttribute(key, attr) {
        this.attributes[key] = attr;

        // Set options
        attr.id = ATTR_ID++; // TODO: currently unused, remove?
        attr.size = attr.size || 1;
        attr.type =
            attr.type ||
            (attr.data.constructor === Float32Array
                ? this.gl.FLOAT
                : attr.data.constructor === Uint16Array
                ? this.gl.UNSIGNED_SHORT
                : this.gl.UNSIGNED_INT); // Uint32Array
        attr.target = key === 'index' ? this.gl.ELEMENT_ARRAY_BUFFER : this.gl.ARRAY_BUFFER;
        attr.normalized = attr.normalized || false;
        attr.stride = attr.stride || 0;
        attr.offset = attr.offset || 0;
        attr.count = attr.count || (attr.stride ? attr.data.byteLength / attr.stride : attr.data.length / attr.size);
        attr.divisor = attr.instanced || 0;
        attr.needsUpdate = false;
        attr.usage = attr.usage || this.gl.STATIC_DRAW;

        if (!attr.buffer) {
            // Push data to buffer
            this.updateAttribute(attr);
        }

        // Update geometry counts. If indexed, ignore regular attributes
        if (attr.divisor) {
            this.isInstanced = true;
            if (this.instancedCount && this.instancedCount !== attr.count * attr.divisor) {
                console.warn('geometry has multiple instanced buffers of different length');
                return (this.instancedCount = Math.min(this.instancedCount, attr.count * attr.divisor));
            }
            this.instancedCount = attr.count * attr.divisor;
        } else if (key === 'index') {
            this.drawRange.count = attr.count;
        } else if (!this.attributes.index) {
            this.drawRange.count = Math.max(this.drawRange.count, attr.count);
        }
    }

    updateAttribute(attr) {
        const isNewBuffer = !attr.buffer;
        if (isNewBuffer) attr.buffer = this.gl.createBuffer();
        if (this.glState.boundBuffer !== attr.buffer) {
            this.gl.bindBuffer(attr.target, attr.buffer);
            this.glState.boundBuffer = attr.buffer;
        }
        if (isNewBuffer) {
            this.gl.bufferData(attr.target, attr.data, attr.usage);
        } else {
            this.gl.bufferSubData(attr.target, 0, attr.data);
        }
        attr.needsUpdate = false;
    }

    setIndex(value) {
        this.addAttribute('index', value);
    }

    setDrawRange(start, count) {
        this.drawRange.start = start;
        this.drawRange.count = count;
    }

    setInstancedCount(value) {
        this.instancedCount = value;
    }

    createVAO(program) {
        this.VAOs[program.attributeOrder] = this.gl.renderer.createVertexArray();
        this.gl.renderer.bindVertexArray(this.VAOs[program.attributeOrder]);
        this.bindAttributes(program);
    }

    bindAttributes(program) {
        // Link all attributes to program using gl.vertexAttribPointer
        program.attributeLocations.forEach((location, { name, type }) => {
            // If geometry missing a required shader attribute
            if (!this.attributes[name]) {
                console.warn(`active attribute ${name} not being supplied`);
                return;
            }

            const attr = this.attributes[name];

            this.gl.bindBuffer(attr.target, attr.buffer);
            this.glState.boundBuffer = attr.buffer;

            // For matrix attributes, buffer needs to be defined per column
            let numLoc = 1;
            if (type === 35674) numLoc = 2; // mat2
            if (type === 35675) numLoc = 3; // mat3
            if (type === 35676) numLoc = 4; // mat4

            const size = attr.size / numLoc;
            const stride = numLoc === 1 ? 0 : numLoc * numLoc * 4;
            const offset = numLoc === 1 ? 0 : numLoc * 4;

            for (let i = 0; i < numLoc; i++) {
                this.gl.vertexAttribPointer(location + i, size, attr.type, attr.normalized, attr.stride + stride, attr.offset + i * offset);
                this.gl.enableVertexAttribArray(location + i);

                // For instanced attributes, divisor needs to be set.
                // For firefox, need to set back to 0 if non-instanced drawn after instanced. Else won't render
                this.gl.renderer.vertexAttribDivisor(location + i, attr.divisor);
            }
        });

        // Bind indices if geometry indexed
        if (this.attributes.index) this.gl.bindBuffer(this.gl.ELEMENT_ARRAY_BUFFER, this.attributes.index.buffer);
    }

    draw({ program, mode = this.gl.TRIANGLES }) {
        if (this.gl.renderer.currentGeometry !== `${this.id}_${program.attributeOrder}`) {
            if (!this.VAOs[program.attributeOrder]) this.createVAO(program);
            this.gl.renderer.bindVertexArray(this.VAOs[program.attributeOrder]);
            this.gl.renderer.currentGeometry = `${this.id}_${program.attributeOrder}`;
        }

        // Check if any attributes need updating
        program.attributeLocations.forEach((location, { name }) => {
            const attr = this.attributes[name];
            if (attr.needsUpdate) this.updateAttribute(attr);
        });

        // For drawElements, offset needs to be multiple of type size
        let indexBytesPerElement = 2;
        if (this.attributes.index?.type === this.gl.UNSIGNED_INT) indexBytesPerElement = 4;

        if (this.isInstanced) {
            if (this.attributes.index) {
                this.gl.renderer.drawElementsInstanced(
                    mode,
                    this.drawRange.count,
                    this.attributes.index.type,
                    this.attributes.index.offset + this.drawRange.start * indexBytesPerElement,
                    this.instancedCount
                );
            } else {
                this.gl.renderer.drawArraysInstanced(mode, this.drawRange.start, this.drawRange.count, this.instancedCount);
            }
        } else {
            if (this.attributes.index) {
                this.gl.drawElements(
                    mode,
                    this.drawRange.count,
                    this.attributes.index.type,
                    this.attributes.index.offset + this.drawRange.start * indexBytesPerElement
                );
            } else {
                this.gl.drawArrays(mode, this.drawRange.start, this.drawRange.count);
            }
        }
    }

    getPosition() {
        // Use position buffer, or min/max if available
        const attr = this.attributes.position;
        // if (attr.min) return [...attr.min, ...attr.max];
        if (attr.data) return attr;
        if (isBoundsWarned) return;
        console.warn('No position buffer data found to compute bounds');
        return (isBoundsWarned = true);
    }

    computeBoundingBox(attr) {
        if (!attr) attr = this.getPosition();
        const array = attr.data;
        // Data loaded shouldn't haave stride, only buffers
        // const stride = attr.stride ? attr.stride / array.BYTES_PER_ELEMENT : attr.size;
        const stride = attr.size;

        if (!this.bounds) {
            this.bounds = {
                min: new Vec3(),
                max: new Vec3(),
                center: new Vec3(),
                scale: new Vec3(),
                radius: Infinity,
            };
        }

        const min = this.bounds.min;
        const max = this.bounds.max;
        const center = this.bounds.center;
        const scale = this.bounds.scale;

        min.set(+Infinity);
        max.set(-Infinity);

        // TODO: check size of position (eg triangle with Vec2)
        for (let i = 0, l = array.length; i < l; i += stride) {
            const x = array[i];
            const y = array[i + 1];
            const z = array[i + 2];

            min.x = Math.min(x, min.x);
            min.y = Math.min(y, min.y);
            min.z = Math.min(z, min.z);

            max.x = Math.max(x, max.x);
            max.y = Math.max(y, max.y);
            max.z = Math.max(z, max.z);
        }

        scale.sub(max, min);
        center.add(min, max).divide(2);
    }

    computeBoundingSphere(attr) {
        if (!attr) attr = this.getPosition();
        const array = attr.data;
        // Data loaded shouldn't haave stride, only buffers
        // const stride = attr.stride ? attr.stride / array.BYTES_PER_ELEMENT : attr.size;
        const stride = attr.size;

        if (!this.bounds) this.computeBoundingBox(attr);

        let maxRadiusSq = 0;
        for (let i = 0, l = array.length; i < l; i += stride) {
            tempVec3.fromArray(array, i);
            maxRadiusSq = Math.max(maxRadiusSq, this.bounds.center.squaredDistance(tempVec3));
        }

        this.bounds.radius = Math.sqrt(maxRadiusSq);
    }

    remove() {
        for (let key in this.VAOs) {
            this.gl.renderer.deleteVertexArray(this.VAOs[key]);
            delete this.VAOs[key];
        }
        for (let key in this.attributes) {
            this.gl.deleteBuffer(this.attributes[key].buffer);
            delete this.attributes[key];
        }
    }
}

return {Geometry};
})();
window.WenlvOGL=Object.freeze({Renderer:__ogl2.Renderer,Program:__ogl3.Program,RenderTarget:__ogl5.RenderTarget,Geometry:__ogl6.Geometry});
})();
/* Local fluid solver built on the official npm OGL 1.0.11 core.
 * Equations/pipeline reviewed against OGL's Post Fluid Distortion example,
 * which credits Pavel Dobryakov. Notices and pinned sources are preserved in
 * evidence/solver-evaluation/references and THIRD_PARTY_NOTICES.txt.
 * This module does not load or run the upstream HTML example or liquidGL. */
(() => {
 'use strict';
 const vertex=`#version 300 es
 in vec2 position;out vec2 uv;void main(){uv=position*.5+.5;gl_Position=vec4(position,0.,1.);}`;
 const header=`#version 300 es
 precision highp float;in vec2 uv;out vec4 result;
 uniform sampler2D a,b;uniform vec2 cell,point,impulse,filterAxis;uniform float dt,decay,aspect,radius,gain;
 `;
 const kernels={
  advect:`void main(){vec2 back=uv-texture(b,uv).xy*cell*dt;result=texture(a,back)*decay;}`,
  soften:`void main(){vec2 d=cell*filterAxis*1.6;result=texture(a,uv)*.2270270270+(texture(a,uv+d*1.3846153846)+texture(a,uv-d*1.3846153846))*.3162162162+(texture(a,uv+d*3.2307692308)+texture(a,uv-d*3.2307692308))*.0702702703;}`,
  splat:`void main(){vec2 d=(uv-point)*vec2(aspect,1.);float weight=exp(-dot(d,d)/radius);vec2 value=texture(a,uv).xy+impulse*weight;result=vec4(clamp(value,vec2(-700.),vec2(700.)),0.,1.);}`,
  curl:`void main(){float l=texture(a,uv-vec2(cell.x,0.)).y,r=texture(a,uv+vec2(cell.x,0.)).y,t=texture(a,uv+vec2(0.,cell.y)).x,d=texture(a,uv-vec2(0.,cell.y)).x;result=vec4((r-l-t+d)*.5,0.,0.,1.);}`,
  confine:`void main(){float l=abs(texture(b,uv-vec2(cell.x,0.)).x),r=abs(texture(b,uv+vec2(cell.x,0.)).x),t=abs(texture(b,uv+vec2(0.,cell.y)).x),d=abs(texture(b,uv-vec2(0.,cell.y)).x);vec2 direction=vec2(t-d,l-r);direction/=length(direction)+.0001;vec2 velocity=texture(a,uv).xy+direction*texture(b,uv).x*gain*dt;result=vec4(clamp(velocity,vec2(-500.),vec2(500.)),0.,1.);}`,
  divergence:`void main(){vec2 c=texture(a,uv).xy;float l=texture(a,uv-vec2(cell.x,0.)).x,r=texture(a,uv+vec2(cell.x,0.)).x,t=texture(a,uv+vec2(0.,cell.y)).y,d=texture(a,uv-vec2(0.,cell.y)).y;if(uv.x<cell.x)l=-c.x;if(uv.x>1.-cell.x)r=-c.x;if(uv.y<cell.y)d=-c.y;if(uv.y>1.-cell.y)t=-c.y;result=vec4((r-l+t-d)*.5,0.,0.,1.);}`,
  clear:`void main(){result=texture(a,uv)*decay;}`,
  pressure:`void main(){float l=texture(a,uv-vec2(cell.x,0.)).x,r=texture(a,uv+vec2(cell.x,0.)).x,t=texture(a,uv+vec2(0.,cell.y)).x,d=texture(a,uv-vec2(0.,cell.y)).x;result=vec4((l+r+t+d-texture(b,uv).x)*.25,0.,0.,1.);}`,
  project:`void main(){float l=texture(b,uv-vec2(cell.x,0.)).x,r=texture(b,uv+vec2(cell.x,0.)).x,t=texture(b,uv+vec2(0.,cell.y)).x,d=texture(b,uv-vec2(0.,cell.y)).x;result=vec4(texture(a,uv).xy-vec2(r-l,t-d),0.,1.);}`
 };
 function create(gl,canvas){
  const {Renderer,Program,RenderTarget,Geometry}=window.WenlvOGL;
  if(!gl.getExtension('EXT_color_buffer_float'))throw Error('Float render targets unavailable');
  const renderer=new Renderer({canvas,width:canvas.width,height:canvas.height,dpr:1,webgl:2,alpha:true,depth:false,stencil:false,antialias:false,autoClear:false});
  if(renderer.gl!==gl)throw Error('OGL must share the existing context');canvas.style.width='100%';canvas.style.height='100%';
  const resolution=128,iterations=8,targets=[],programs={};
  const geometry=new Geometry(gl,{position:{size:2,data:new Float32Array([-1,-1,3,-1,-1,3])}});
  function release(){geometry.remove();Object.values(programs).forEach(p=>p.remove());targets.forEach(t=>{gl.deleteFramebuffer(t.buffer);t.textures.forEach(x=>gl.deleteTexture(x.texture))});delete gl.renderer;}
  try {
  function target(){const rt=new RenderTarget(gl,{width:resolution,height:resolution,type:gl.HALF_FLOAT,format:gl.RGBA,internalFormat:gl.RGBA16F,minFilter:gl.LINEAR,magFilter:gl.LINEAR,depth:false});targets.push(rt);renderer.bindFramebuffer(rt);if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw Error('Incomplete fluid framebuffer');gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);return rt;}
  function pair(){return{read:target(),write:target(),swap(){[this.read,this.write]=[this.write,this.read]}};}
  const velocity=pair(),pressure=pair(),dye=pair(),softened=pair(),divergence=target(),curl=target();
  const uniforms={a:{value:velocity.read.texture},b:{value:velocity.read.texture},cell:{value:[1/resolution,1/resolution]},point:{value:[.5,.5]},impulse:{value:[0,0]},filterAxis:{value:[1,0]},dt:{value:1/30},decay:{value:1},aspect:{value:1},radius:{value:.014},gain:{value:18}};
  for(const[name,fragment]of Object.entries(kernels)){programs[name]=new Program(gl,{vertex,fragment:header+fragment,uniforms,depthTest:false,depthWrite:false,cullFace:false});if(!gl.getProgramParameter(programs[name].program,gl.LINK_STATUS))throw Error('Fluid program did not link: '+name);}
  let lastTime=0,steps=0,passes=0,lastMouse=null,pending={dx:0,dy:0,x:.5,y:.5},disposed=false,lastImpulseAt=0,tailSeconds=0;
  function resetState(){const s=renderer.state;s.currentProgram=null;s.framebuffer=null;s.viewport.width=null;s.viewport.height=null;s.textureUnits=[];s.activeTextureUnit=-1;s.boundBuffer=null;s[gl.BLEND]=null;s[gl.DEPTH_TEST]=null;s[gl.CULL_FACE]=null;renderer.currentGeometry=null;gl.bindVertexArray(null);gl.disable(gl.SCISSOR_TEST);}
  function pass(name,target,a,b=null,decay=1){uniforms.a.value=a.texture;uniforms.b.value=(b||a).texture;uniforms.decay.value=decay;renderer.bindFramebuffer(target);renderer.setViewport(resolution,resolution);const program=programs[name];program.use();geometry.draw({program});passes++;}
  function pointer(x,y,now,width=innerWidth,height=innerHeight){if(lastMouse){const dx=x-lastMouse.x,dy=y-lastMouse.y;if(Math.abs(dx)+Math.abs(dy)>.01){pending.dx+=dx*4;pending.dy-=dy*4;lastImpulseAt=now;tailSeconds=16;}}lastMouse={x,y};pending.x=x/width;pending.y=1-y/height;}
  function leave(){lastMouse=null;}
  function step(now,width=innerWidth,height=innerHeight){if(disposed||tailSeconds<=0){lastTime=0;return;}const dt=Math.min(.034,Math.max(.008,(now-(lastTime||now-33.3))/1000));lastTime=now;tailSeconds=Math.max(0,tailSeconds-dt);resetState();uniforms.dt.value=dt;uniforms.aspect.value=width/height;
   if(Math.abs(pending.dx)+Math.abs(pending.dy)>.01){const speed=Math.hypot(pending.dx,pending.dy),scale=Math.min(1,220/speed);uniforms.point.value=[pending.x,pending.y];uniforms.impulse.value=[pending.dx*scale,pending.dy*scale];pass('splat',velocity.write,velocity.read);velocity.swap();pass('splat',dye.write,dye.read);dye.swap();pending.dx=0;pending.dy=0;}
   pass('advect',velocity.write,velocity.read,velocity.read,Math.exp(-dt*.75));velocity.swap();
   pass('curl',curl,velocity.read);pass('confine',velocity.write,velocity.read,curl);velocity.swap();
   pass('divergence',divergence,velocity.read);pass('clear',pressure.write,pressure.read,null,.8);pressure.swap();
   for(let i=0;i<iterations;i++){pass('pressure',pressure.write,pressure.read,divergence);pressure.swap();}
   pass('project',velocity.write,velocity.read,pressure.read);velocity.swap();
   pass('advect',dye.write,dye.read,velocity.read,Math.exp(-dt*.62));dye.swap();
   // Filter only the low-resolution display displacement, never the video,
   // text, glass edges, or physical velocity/pressure history.
   uniforms.filterAxis.value=[1,0];pass('soften',softened.write,dye.read);softened.swap();
   uniforms.filterAxis.value=[0,1];pass('soften',softened.write,softened.read);softened.swap();steps++;
   gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.bindVertexArray(null);
  }
  function inspect(){return{backend:'OGL 1.0.11 (official npm)',resolution,iterations,steps,passes,renderTargets:targets.length,programs:Object.keys(programs).length,halfFloat:true,lastImpulseAt,tailSeconds};}
  function diagnostics(){const saved=gl.getParameter(gl.FRAMEBUFFER_BINDING);const read=rt=>{gl.bindFramebuffer(gl.FRAMEBUFFER,rt.buffer);const out=new Float32Array(resolution*resolution*4);gl.readPixels(0,0,resolution,resolution,gl.RGBA,gl.FLOAT,out);return out;};const pre=read(divergence),vel=read(velocity.read),ink=read(dye.read);gl.bindFramebuffer(gl.FRAMEBUFFER,saved);let preSum=0,postSum=0,peak=0,energy=0;const at=(x,y,k)=>vel[4*(Math.max(0,Math.min(resolution-1,y))*resolution+Math.max(0,Math.min(resolution-1,x)))+k];for(let y=1;y<resolution-1;y++)for(let x=1;x<resolution-1;x++){const i=4*(y*resolution+x);preSum+=Math.abs(pre[i]);postSum+=Math.abs((at(x+1,y,0)-at(x-1,y,0)+at(x,y+1,1)-at(x,y-1,1))*.5);peak=Math.max(peak,Math.hypot(vel[i],vel[i+1]));energy+=Math.hypot(ink[i],ink[i+1]);}const cells=(resolution-2)**2;return{...inspect(),finite:[pre,vel,ink].every(a=>a.every(Number.isFinite)),preProjectionMeanDivergence:preSum/cells,postProjectionMeanDivergence:postSum/cells,divergenceRatio:postSum/Math.max(preSum,.000001),peakVelocity:peak,meanDisplacementField:energy/cells,GLerror:gl.getError()};}
  return{step,pointer,leave,inspect,diagnostics,get texture(){return softened.read.texture.texture},pause(){lastTime=0;pending.dx=0;pending.dy=0;lastMouse=null},dispose(){if(disposed)return;disposed=true;release();}};
  } catch(error){release();throw error;}
 }
 window.WenlvOGLFluid=Object.freeze({create});
})();

/* Original procedural light field, baked locally to a seamless 15s plate.
 * The shared plate is softened once offline, avoiding repeated card captures.
 * Native video decoding keeps the UI responsive. Glass uses the playback clock.
 * Source and reproducible renderer are included in the handoff, not fetched. */
(() => {
  'use strict';
  function create(host, options = {}) {
    const video=document.createElement('video');
    video.className='studio-dream-video';video.setAttribute('aria-hidden','true');
    video.muted=true;video.defaultMuted=true;video.loop=true;video.playsInline=true;
    video.preload='auto';video.poster='/ui/dream-field-poster.png';video.src='/ui/dream-field.mp4';
    host.append(video);host.dataset.renderer='dream-film';
    const materialMode=new URL(location.href).searchParams.get('glass')??'webgl';
    if(materialMode==='webgl')host.dreamGlass=window.StudioDreamGlassScene?.create(video,host,options.glass);
    if(materialMode==='sidebar')host.dreamGlass=window.StudioDreamGlass?.create(video,document.querySelector('.studio-sidebar'));
    let frames=0,running=false,disposed=false,callback=0,lastLight=-1,playRequest=0;
    const hasVideoClock=typeof video.requestVideoFrameCallback==='function';
    function illuminate(){
      const seconds=video.currentTime,phase=3+14*(1-Math.cos(2*Math.PI*seconds/15)),t=phase*.145;
      // Slow environmental light does not need per-frame document style work.
      // Native decoding continues at the source cadence between these updates.
      if(Math.abs(seconds-lastLight)>.65||lastLight<0){
        const ax=.58+.15*Math.sin(t*.42),ay=.28+.17*Math.cos(t*.36),strengthA=.95+.20*Math.sin(t*.51+.5),strengthB=.9+.20*Math.cos(t*.47),style=document.documentElement.style;
        style.setProperty('--dream-light-x',(ax*100).toFixed(2)+'%');style.setProperty('--dream-light-y',(ay*100).toFixed(2)+'%');
        style.setProperty('--dream-rim',(0.20+strengthA*.1).toFixed(3));style.setProperty('--dream-blue-rim',(0.10+strengthB*.09).toFixed(3));lastLight=seconds;
      }
    }
    function cancel(){if(!callback)return;if(hasVideoClock)video.cancelVideoFrameCallback(callback);else cancelAnimationFrame(callback);callback=0;}
    function tick(){callback=0;if(disposed||!running)return;frames++;illuminate();host.dreamGlass?.render();callback=hasVideoClock?video.requestVideoFrameCallback(tick):requestAnimationFrame(tick);}
    function setRunning(value){
      if(disposed)return;value=Boolean(value);host.dreamGlass?.setRunning?.(value);if(value===running)return;running=value;cancel();const request=++playRequest;
      if(running){video.play().then(()=>{if(request!==playRequest||disposed)return;if(!running){video.pause();return;}if(!callback)callback=hasVideoClock?video.requestVideoFrameCallback(tick):requestAnimationFrame(tick);}).catch(()=>{if(request!==playRequest||disposed)return;running=false;video.pause();host.dispatchEvent(new Event('dream:play-blocked'));});}
      else video.pause();
    }
    video.addEventListener('loadeddata',illuminate);
    video.addEventListener('error',()=>{setRunning(false);host.dataset.renderer='unavailable';host.dispatchEvent(new Event('dream:play-blocked'));});
    illuminate();
    return {setRunning,get state(){return {phase:video.currentTime,frames,running:running&&!video.paused,renderer:host.dataset.renderer,readyState:video.readyState,totalVideoFrames:video.getVideoPlaybackQuality?.().totalVideoFrames||0,droppedFrames:video.getVideoPlaybackQuality?.().droppedVideoFrames||0};},dispose(){setRunning(false);host.dreamGlass?.dispose();delete host.dreamGlass;disposed=true;cancel();video.removeAttribute('src');video.load();video.remove();delete host.dataset.renderer;}};
  }
  window.StudioDreamField=Object.freeze({create});
})();

/* Original screen-space WebGL glass experiment. Only the fixed sidebar is drawn.
 * The live, existing video is the transmitted environment; DOM text stays sharp.
 * No upstream Lemo code, Canvas2D filter, scene capture, or second video decoder. */
(() => {
  'use strict';
  const vs = `#version 300 es
    in vec2 position; out vec2 uv;
    void main(){uv=position*.5+.5;gl_Position=vec4(position,0.,1.);}`;
  const fs = `#version 300 es
    precision highp float;
    in vec2 uv; out vec4 frag;
    uniform sampler2D backdrop;
    uniform vec2 viewport, paneSize, videoSize;
    uniform vec2 paneOrigin;
    uniform float clock, daylight, refraction;
    vec2 sourceUV(vec2 screen){
      float cover=max(viewport.x/videoSize.x,viewport.y/videoSize.y);
      vec2 visible=viewport/(videoSize*cover);
      return clamp((screen-.5)*visible+.5,vec2(.001),vec2(.999));
    }
    vec3 environment(vec2 screen){vec3 scene=texture(backdrop,sourceUV(screen)).rgb;return mix(scene,mix(vec3(.96,.95,.98),scene,.21),daylight);}
    void main(){
      vec2 local=vec2(uv.x,1.-uv.y)*paneSize;
      vec2 p=local-paneSize*.5, q=abs(p)-paneSize*.5+vec2(18.);
      float sd=length(max(q,0.))+min(max(q.x,q.y),0.)-18.;
      float coverage=1.-smoothstep(-.5,.5,sd);
      if(coverage<=0.){frag=vec4(0.);return;}
      float depth=max(-sd,0.);
      vec2 outward;
      if(q.x>0.&&q.y>0.)outward=normalize(sign(p)*max(q,vec2(.001)));
      else outward=q.x>q.y?vec2(sign(p.x),0.):vec2(0.,sign(p.y));
      // A rounded solid edge changes its normal through the 18px bevel.
      // Refraction uses Snell's law for three nearby indices of refraction.
      float slope=3.5*exp(-depth/5.8);
      vec3 normal=normalize(vec3(outward*slope,1.));
      vec3 incident=vec3(0.,0.,-1.);
      vec3 rr=refract(incident,normal,1./1.455);
      vec3 rg=refract(incident,normal,1./1.470);
      vec3 rb=refract(incident,normal,1./1.485);
      vec2 screen=(paneOrigin+local)/viewport;
      float thickness=50.*refraction;
      vec2 dr=rr.xy/max(-rr.z,.25)*thickness/viewport;
      vec2 dg=rg.xy/max(-rg.z,.25)*thickness/viewport;
      vec2 db=rb.xy/max(-rb.z,.25)*thickness/viewport;
      vec3 transmitted=vec3(environment(screen+dr).r,environment(screen+dg).g,environment(screen+db).b);
      // Same scene clock and light positions as the dream field, never random.
      float phase=3.+14.*(1.-cos(6.2831853*clock/15.)),t=phase*.145;
      vec2 light=vec2(.58+.15*sin(t*.42),.28+.17*cos(t*.36));
      vec2 lightDirection=normalize((light-screen)*viewport);
      float lit=.25+.75*max(dot(outward,lightDirection),0.);
      float fresnel=.035+.965*pow(1.-normal.z,5.);
      vec3 reflection=environment(screen+outward*.085)+vec3(.13,.15,.24);
      vec3 tint=mix(vec3(.043,.043,.114),vec3(.90,.92,.97),daylight);
      vec3 col=mix(transmitted,tint,.24);
      col=mix(col,reflection,min(.50,fresnel*(.5+lit)));
      // Bright outer lip, darker internal edge and a broad reflected shoulder.
      float lip=exp(-pow((depth-1.25)/.72,2.));
      float shoulder=exp(-pow((depth-5.2)/2.8,2.));
      float innerShadow=exp(-pow((depth-11.5)/3.3,2.));
      float lightBand=exp(-pow((screen.y-light.y)/.20,2.));
      float movingLight=.76+.24*sin((screen.y-light.y)*4.+t*.25);
      col+=vec3(.70,.76,.91)*lip*(.075+.48*lightBand*lit)*movingLight;
      col+=vec3(.30,.35,.57)*shoulder*lit*.09;
      col*=1.-innerShadow*.095;
      // Broad front-face reflection is restrained so small navigation text reads.
      col+=vec3(.035,.029,.060)*pow(max(0.,1.-local.y/paneSize.y),2.);
      frag=vec4(col,coverage);
    }`;
  function create(video, sidebar) {
    const canvas=document.createElement('canvas');canvas.className='studio-glass-webgl';canvas.setAttribute('aria-hidden','true');
    const gl=canvas.getContext('webgl2',{alpha:true,antialias:false,depth:false,stencil:false,premultipliedAlpha:false,preserveDrawingBuffer:false});
    if(!gl){sidebar.dataset.glassStatus='webgl-unavailable';return null;}
    const shaders=[];
    function compile(type,source){const s=gl.createShader(type);shaders.push(s);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw new Error(gl.getShaderInfoLog(s));return s;}
    let program;
    try{program=gl.createProgram();gl.attachShader(program,compile(gl.VERTEX_SHADER,vs));gl.attachShader(program,compile(gl.FRAGMENT_SHADER,fs));gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(program));}
    catch(error){sidebar.dataset.glassStatus='compile-failed';sidebar.dataset.glassError=String(error.message);shaders.forEach(s=>gl.deleteShader(s));if(program)gl.deleteProgram(program);return null;}
    shaders.forEach(s=>gl.deleteShader(s));gl.useProgram(program);
    const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
    const a=gl.getAttribLocation(program,'position');gl.enableVertexAttribArray(a);gl.vertexAttribPointer(a,2,gl.FLOAT,false,0,0);
    const texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    const u={};for(const n of ['backdrop','viewport','paneSize','videoSize','paneOrigin','clock','daylight','refraction'])u[n]=gl.getUniformLocation(program,n);gl.uniform1i(u.backdrop,0);gl.uniform1f(u.refraction,1);
    let disposed=false,frames=0,uploads=0,lastMedia=-1,dirty=true,rect;
    const reduce=matchMedia('(prefers-reduced-transparency:reduce)'),mobile=matchMedia('(max-width:800px)');
    sidebar.prepend(canvas);sidebar.dataset.glassStatus='waiting';
    function layout(){rect=sidebar.getBoundingClientRect();const w=Math.max(1,Math.round(rect.width)),h=Math.max(1,Math.round(rect.height));if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;gl.viewport(0,0,w,h)}dirty=false;}
    function render(){
      if(disposed||gl.isContextLost()||video.readyState<2)return;
      // This first material sample targets desktop only. The existing mobile
      // drawer must still blur foreground content, not merely the background.
      if(mobile.matches||reduce.matches){sidebar.removeAttribute('data-glass');return;}
      if(dirty)layout();if(!rect?.width||!rect.height)return;
      gl.useProgram(program);gl.bindTexture(gl.TEXTURE_2D,texture);
      if(lastMedia!==video.currentTime){gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,video);lastMedia=video.currentTime;uploads++;}
      gl.uniform2f(u.viewport,innerWidth,innerHeight);gl.uniform2f(u.paneSize,rect.width,rect.height);gl.uniform2f(u.paneOrigin,rect.left,rect.top);gl.uniform2f(u.videoSize,video.videoWidth,video.videoHeight);gl.uniform1f(u.clock,video.currentTime);gl.uniform1f(u.daylight,document.documentElement.dataset.theme==='light'?1:0);
      gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);gl.drawArrays(gl.TRIANGLES,0,6);frames++;if(sidebar.dataset.glass!=='webgl')sidebar.dataset.glass='webgl';if(sidebar.dataset.glassStatus!=='ready')sidebar.dataset.glassStatus='ready';
    }
    function invalidate(){dirty=true;render();}
    const resize=new ResizeObserver(invalidate);resize.observe(sidebar);
    const theme=new MutationObserver(render);theme.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
    window.addEventListener('resize',invalidate);video.addEventListener('loadeddata',render);video.addEventListener('seeked',render);reduce.addEventListener('change',invalidate);mobile.addEventListener('change',invalidate);
    canvas.addEventListener('webglcontextlost',event=>{event.preventDefault();sidebar.removeAttribute('data-glass');sidebar.dataset.glassStatus='context-lost';});
    function inspect(){const ext=gl.getExtension('WEBGL_debug_renderer_info');return{frames,uploads,width:canvas.width,height:canvas.height,mediaTime:video.currentTime,contextLost:gl.isContextLost(),error:gl.getError(),renderer:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),state:sidebar.dataset.glassStatus};}
    render();
    return{render,inspect,dispose(){if(disposed)return;disposed=true;resize.disconnect();theme.disconnect();window.removeEventListener('resize',invalidate);video.removeEventListener('loadeddata',render);video.removeEventListener('seeked',render);reduce.removeEventListener('change',invalidate);mobile.removeEventListener('change',invalidate);gl.deleteBuffer(buffer);gl.deleteTexture(texture);gl.deleteProgram(program);canvas.remove();sidebar.removeAttribute('data-glass');sidebar.dataset.glassStatus='disposed';}};
  }
  window.StudioDreamGlass=Object.freeze({create});
})();

/* Shared WebGL scene. Raised-edge material adapts the MIT liquidGL v3
 * SDF/bevel mechanism (NaughtyDuk); see depth-candidate/THIRD_PARTY_NOTICES.txt.
 * The upstream library is not executed. DOM text remains outside the shader. */
(() => {
  'use strict';
  const vs = `#version 300 es
    in vec2 position; out vec2 uv;
    void main(){uv=position*.5+.5;gl_Position=vec4(position,0.,1.);}`;
  const fs = `#version 300 es
    precision highp float;
    in vec2 uv; out vec4 frag;
    uniform sampler2D backdrop, simulation, sceneFrame;
    uniform float simulated, useSceneFrame, raised;
    uniform vec2 viewport, paneSize, videoSize;
    uniform vec2 paneOrigin, pointer, wake, force;
    uniform float influence;
    uniform float clock, daylight, refraction, radius, tintAmount, surfaceMode;
    vec2 sourceUV(vec2 screen){
      float cover=max(viewport.x/videoSize.x,viewport.y/videoSize.y);
      vec2 visible=viewport/(videoSize*cover);
      if(simulated>.5){
        vec2 field=texture(simulation,vec2(screen.x,1.-screen.y)).xy;
        vec2 offset=vec2(-field.x,field.y)*.00055;
        // Smoothly bound deformation; a hard length clamp produced ridges.
        float pixels=length(offset*viewport);offset/=sqrt(1.+pow(pixels/160.,2.));
        return clamp(((screen-.5+offset)/1.055)*visible+.5,vec2(.001),vec2(.999));
      }
      // Local advection and a trailing counter-vortex, never a rigid page drag.
      vec2 center=(pointer+1.)*.5, delta=(screen-center)*viewport;
      float size=min(viewport.x,viewport.y)*.31;
      float near=exp(-dot(delta,delta)/(size*size));
      vec2 tail=(screen-(wake+1.)*.5)*viewport;
      float trail=exp(-dot(tail,tail)/(size*size*.64));
      float breath=sin(clock*6.2831853/15.);
      float angle=influence*(near*(.58+.12*breath)-trail*.22);
      mat2 turn=mat2(cos(angle),-sin(angle),sin(angle),cos(angle));
      vec2 displacement=(turn*delta-delta)*near;
      displacement-=force*near;
      displacement+=delta*near*influence*(.13+.055*breath);
      displacement+=vec2(-tail.y,tail.x)*trail*influence*.16;
      vec2 warped=(screen-.5+displacement/viewport)/1.055;
      return clamp(warped*visible+.5,vec2(.001),vec2(.999));
    }
    vec3 environment(vec2 screen){
      if(useSceneFrame>.5)return texture(sceneFrame,clamp(vec2(screen.x,1.-screen.y),vec2(.001),vec2(.999))).rgb;
      vec3 scene=texture(backdrop,sourceUV(screen)).rgb;return mix(scene,mix(vec3(.96,.95,.98),scene,.21),daylight);
    }
    void main(){
      vec2 local=vec2(uv.x,1.-uv.y)*paneSize;
      if(surfaceMode<.5){frag=vec4(environment(local/viewport),1.);return;}
      vec2 p=local-paneSize*.5, q=abs(p)-paneSize*.5+vec2(radius);
      float sd=length(max(q,0.))+min(max(q.x,q.y),0.)-radius;
      float coverage=1.-smoothstep(-.5,.5,sd);
      if(coverage<=0.)discard;
      float depth=max(-sd,0.);
      vec2 outward;
      if(q.x>0.&&q.y>0.)outward=normalize(sign(p)*max(q,vec2(.001)));
      else outward=q.x>q.y?vec2(sign(p.x),0.):vec2(0.,sign(p.y));
      if(raised>.5){
        // liquidGL-style narrow bevel: calm centre, a steep outer thickness.
        // Offsets are CSS pixels divided by the shared scene's CSS viewport.
        float bevel=min(paneSize.x,paneSize.y)<100.?5.:7.;
        float edge=1.-smoothstep(0.,bevel,depth);
        float bend=edge*4.2+pow(edge,10.)*1.8;
        vec2 screen=(paneOrigin+local)/viewport;
        vec2 mapped=screen-p*.003/viewport;
        vec2 offset=outward*bend/viewport;
        vec3 transmitted=vec3(environment(mapped+offset*1.025).r,environment(mapped+offset).g,environment(mapped+offset*.975).b);
        vec2 key=normalize(vec2(-.62,-.78));float lightSide=max(0.,dot(outward,key)),darkSide=max(0.,dot(outward,-key));
        vec3 tint=mix(vec3(.055,.060,.14),vec3(.94,.96,1.),daylight);
        vec3 col=mix(transmitted,tint,tintAmount);
        // Broad, shared diagonal reflection; highlights do not move the panel.
        float stripe=exp(-pow((screen.y+screen.x*.32-.26-.012*sin(clock*.22))/.065,2.));
        float shoulder=exp(-pow((depth-2.6)/1.9,2.));
        float lip=exp(-pow((depth-1.1)/.85,2.));
        float darkLip=exp(-pow((depth-1.7)/1.35,2.));
        // Bright-room reflections need less additive energy: retain the rim's
        // gradient instead of clipping a broad strip to display white.
        float specularExposure=mix(1.,.28,daylight);
        col+=vec3(.64,.73,.94)*stripe*.050*specularExposure;
        col+=vec3(.70,.81,1.)*shoulder*lightSide*.10*specularExposure;
        col+=vec3(.85,.91,1.)*lip*(.025+.26*lightSide)*specularExposure;
        // A soft directional thickness cue; no closed dark inner contour.
        col*=1.-darkLip*darkSide*.08;
        frag=vec4(col,coverage);return;
      }
      // A rounded solid edge changes its normal through the 18px bevel.
      // Refraction uses Snell's law for three nearby indices of refraction.
      float slope=3.5*exp(-depth/5.8);
      vec3 normal=normalize(vec3(outward*slope,1.));
      vec3 incident=vec3(0.,0.,-1.);
      vec3 rr=refract(incident,normal,1./1.455);
      vec3 rg=refract(incident,normal,1./1.470);
      vec3 rb=refract(incident,normal,1./1.485);
      vec2 screen=(paneOrigin+local)/viewport;
      float thickness=50.*refraction;
      vec2 dr=rr.xy/max(-rr.z,.25)*thickness/viewport;
      vec2 dg=rg.xy/max(-rg.z,.25)*thickness/viewport;
      vec2 db=rb.xy/max(-rb.z,.25)*thickness/viewport;
      vec3 transmitted=vec3(environment(screen+dr).r,environment(screen+dg).g,environment(screen+db).b);
      // Same scene clock and light positions as the dream field, never random.
      float phase=3.+14.*(1.-cos(6.2831853*clock/15.)),t=phase*.145;
      vec2 light=vec2(.58+.15*sin(t*.42),.28+.17*cos(t*.36));
      light=mix(light,(pointer+1.)*.5,influence*.60);
      vec2 lightDirection=normalize((light-screen)*viewport);
      float lit=.25+.75*max(dot(outward,lightDirection),0.);
      float fresnel=.035+.965*pow(1.-normal.z,5.);
      vec3 reflection=environment(screen+outward*.085)+vec3(.13,.15,.24);
      vec3 tint=mix(vec3(.043,.043,.114),vec3(.90,.92,.97),daylight);
      vec3 col=mix(transmitted,tint,tintAmount);
      col=mix(col,reflection,min(.50,fresnel*(.5+lit)));
      // Bright outer lip, darker internal edge and a broad reflected shoulder.
      float lip=exp(-pow((depth-1.25)/.72,2.));
      float shoulder=exp(-pow((depth-5.2)/2.8,2.));
      float innerShadow=exp(-pow((depth-11.5)/3.3,2.));
      float lightBand=exp(-pow((screen.y-light.y)/.20,2.));
      float movingLight=.76+.24*sin((screen.y-light.y)*4.+t*.25);
      col+=vec3(.70,.76,.91)*lip*(.075+.48*lightBand*lit)*movingLight;
      col+=vec3(.30,.35,.57)*shoulder*lit*.09;
      col*=1.-innerShadow*.095;
      // Broad front-face reflection is restrained so small navigation text reads.
      col+=vec3(.035,.029,.060)*pow(max(0.,1.-local.y/paneSize.y),2.);
      frag=vec4(col,coverage);
    }`;
  function create(video,host,options={}){
    const canvas=document.createElement('canvas');canvas.className='studio-glass-scene';canvas.setAttribute('aria-hidden','true');
    // The shared background fills every pixel with alpha1; glass blends inside
    // this scene. Expose an opaque surface to avoid redundant browser blending.
    const gl=canvas.getContext('webgl2',{alpha:false,antialias:false,depth:false,stencil:false,premultipliedAlpha:false,preserveDrawingBuffer:false});
    if(!gl){host.dataset.glassStatus='webgl-unavailable';return null;}
    // CPU rasterizers report WebGL support but block the UI on each glass
    // readback. Keep native video and CSS glass on these renderers, without
    // changing the user's motion preference or disabling hardware rendering.
    const rendererInfo=gl.getExtension('WEBGL_debug_renderer_info');
    const rendererName=rendererInfo?String(gl.getParameter(rendererInfo.UNMASKED_RENDERER_WEBGL)||''):'';
    if(options.allowSoftwareRendering!==true&&/swiftshader|llvmpipe|softpipe|software rasterizer/i.test(rendererName)){
      host.dataset.glassStatus='software-video';
      gl.getExtension('WEBGL_lose_context')?.loseContext();
      return null;
    }
    const shaders=[];let program;
    function compile(type,source){const s=gl.createShader(type);shaders.push(s);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s;}
    try{program=gl.createProgram();gl.attachShader(program,compile(gl.VERTEX_SHADER,vs));gl.attachShader(program,compile(gl.FRAGMENT_SHADER,fs));gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));}
    catch(e){host.dataset.glassStatus='compile-failed';shaders.forEach(s=>gl.deleteShader(s));if(program)gl.deleteProgram(program);return null;}
    shaders.forEach(s=>gl.deleteShader(s));gl.useProgram(program);
    const buffer=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]),gl.STATIC_DRAW);
    const a=gl.getAttribLocation(program,'position');gl.enableVertexAttribArray(a);gl.vertexAttribPointer(a,2,gl.FLOAT,false,0,0);
    const texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);for(const [n,v] of [[gl.TEXTURE_MIN_FILTER,gl.LINEAR],[gl.TEXTURE_MAG_FILTER,gl.LINEAR],[gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE],[gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE]])gl.texParameteri(gl.TEXTURE_2D,n,v);
    const frameTexture=gl.createTexture(),framebuffer=gl.createFramebuffer();gl.bindTexture(gl.TEXTURE_2D,frameTexture);for(const [n,v]of [[gl.TEXTURE_MIN_FILTER,gl.LINEAR],[gl.TEXTURE_MAG_FILTER,gl.LINEAR],[gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE],[gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE]])gl.texParameteri(gl.TEXTURE_2D,n,v);gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,frameTexture,0);gl.bindFramebuffer(gl.FRAMEBUFFER,null);
    let frameWidth=0,frameHeight=0,frameCopies=0;
    // Native workspaces reuse this one scene. Foreground copies let their fixed
    // chrome sit above canvas nodes without another WebGL context or decoder.
    const foregroundSelector=options.foreground||'.studio-topbar',fronts=new Map();
    function foreground(element){
      if(!element.matches(foregroundSelector))return null;
      const previous=fronts.get(element);
      // Native dialogs replace their contents while retaining the same element.
      // Do not keep drawing into a foreground canvas removed by innerHTML.
      if(previous&&(!previous.canvas.isConnected||previous.canvas.parentElement!==element)){
        previous.canvas.remove();fronts.delete(element);
      }
      if(!fronts.has(element)){const front=document.createElement('canvas');front.className='studio-glass-front';front.setAttribute('aria-hidden','true');front.hidden=true;element.prepend(front);fronts.set(element,{canvas:front,context:front.getContext('2d',{alpha:true})});}
      return fronts.get(element);
    }
    const u={};for(const n of ['backdrop','viewport','paneSize','videoSize','paneOrigin','clock','daylight','refraction','radius','tintAmount','surfaceMode','pointer','wake','force','influence','simulation','simulated','sceneFrame','useSceneFrame','raised'])u[n]=gl.getUniformLocation(program,n);
    gl.uniform1i(u.backdrop,0);gl.uniform1f(u.refraction,1);gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);
    let disposed=false,contextInvalidated=false,running=false,frames=0,uploads=0,lastSource=-1,dirty=true,registryDirty=true,raf=0,lastTick=0,followUntil=0,panes=[],nodes=[],active=new Set(),lastDrawMs=0,maxDrawMs=0,lastRendered=-1000,renderScale=1,sceneWidth=innerWidth,sceneHeight=innerHeight,sceneLeft=0,sceneTop=0;
    const point={x:0,y:0,tx:0,ty:0},fluid={wx:0,wy:0,fx:0,fy:0,amount:0,target:0},selector=options.surfaces||'.studio-sidebar,.studio-topbar,.lib-card-shell,.media-card,.entry-card';
    const raisedSelector=options.raised||'.studio-sidebar,.studio-topbar',nestedSelector=options.nested||'.lib-card-shell,.media-card,.entry-card';
    const reduce=matchMedia('(prefers-reduced-transparency:reduce)'),motion=matchMedia('(prefers-reduced-motion:reduce)'),forced=matchMedia('(forced-colors:active)'),coarse=matchMedia('(hover:none), (pointer:coarse)'),mobile=matchMedia('(max-width:800px)');
    host.after(canvas);host.dataset.glassStatus='waiting';
    let solver=null;
    if(new URL(location.href).searchParams.get('flow')!=='analytic'&&!coarse.matches&&!motion.matches&&!reduce.matches&&!forced.matches){
      try{solver=window.WenlvOGLFluid.create(gl,canvas);host.dataset.fluidBackend='ogl-pressure';}
      catch(error){host.dataset.fluidBackend='analytic-fallback';host.dataset.fluidError=String(error.message);}
    }else host.dataset.fluidBackend='analytic-v5';
    // Restoring a context does not restore its old programs, buffers or textures.
    // Keep this instance in readable CSS/video mode until the next page load.
    function performanceReduced(){return options.performanceFallback&&document.body.dataset.ambientQuality==='static'&&document.body.dataset.ambientReason==='performance';}
    function available(){return !disposed&&!contextInvalidated&&!gl.isContextLost()&&!reduce.matches&&!forced.matches&&!performanceReduced();}
    function interactive(){return available()&&running&&!motion.matches&&!coarse.matches&&!document.hidden;}
    function clearMaterials(){for(const e of active)e.removeAttribute('data-glass-surface');active.clear();canvas.hidden=true;for(const front of fronts.values())front.canvas.hidden=true;video.style.transform='';delete host.dataset.sharedGlass;}
    function layout(){
      if(registryDirty){nodes=[...document.querySelectorAll(selector)].filter(e=>(!e.closest('dialog')||(options.dialogs&&e.matches(options.dialogs)))&&!e.parentElement?.closest(nestedSelector));registryDirty=false;}
      const bounds=canvas.getBoundingClientRect();const w=bounds.width||document.documentElement.clientWidth,h=bounds.height||innerHeight;sceneWidth=w;sceneHeight=h;sceneLeft=bounds.left;sceneTop=bounds.top;renderScale=Math.min(1,960/w,600/h);const cw=Math.round(w*renderScale),ch=Math.round(h*renderScale);if(canvas.width!==cw||canvas.height!==ch){canvas.width=cw;canvas.height=ch;}
      if(frameWidth!==cw||frameHeight!==ch){gl.activeTexture(gl.TEXTURE2);gl.bindTexture(gl.TEXTURE_2D,frameTexture);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA8,cw,ch,0,gl.RGBA,gl.UNSIGNED_BYTE,null);frameWidth=cw;frameHeight=ch;gl.activeTexture(gl.TEXTURE0);}
      panes=[];const visible=new Set();
      for(const e of nodes){if(!e.isConnected||e.closest('[hidden]')||(mobile.matches&&e.matches('.studio-sidebar')))continue;
        const r=e.getBoundingClientRect();if(r.width<2||r.height<2||r.bottom<=0||r.top>=h||r.right<=0||r.left>=w)continue;
        const style=getComputedStyle(e);if(style.display==='none'||style.visibility==='hidden')continue;
        const raised=e.matches(raisedSelector);
        const cornerScale=options.scaledSurfaces&&e.matches(options.scaledSurfaces)?r.width/(e.offsetWidth||r.width):1;
        panes.push({e,x:r.left-sceneLeft,y:r.top-sceneTop,w:r.width,h:r.height,radius:Math.min((parseFloat(style.borderTopLeftRadius)||18)*cornerScale,r.width/2,r.height/2),raised,tint:raised?.13:.40});visible.add(e);
      }
      for(const e of active)if(!visible.has(e))e.removeAttribute('data-glass-surface');active=visible;
      for(const [element,front]of fronts){if(!element.isConnected){front.canvas.remove();fronts.delete(element);}else if(!active.has(element))front.canvas.hidden=true;}
      for(const p of panes)foreground(p.e);dirty=false;
    }
    function render(){
      if(!available()){clearMaterials();if(performanceReduced())host.dataset.glassStatus='performance-fallback';return;}if(video.readyState<2)return;
      const start=performance.now();if(start-lastRendered<32){schedule();return;}lastRendered=start;if(dirty)layout();
      if(solver&&interactive())solver.step(start,sceneWidth,sceneHeight);
      // Restore raw scene state even when a partially initialized solver failed.
      gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.bindVertexArray(null);gl.bindBuffer(gl.ARRAY_BUFFER,buffer);gl.enableVertexAttribArray(a);gl.vertexAttribPointer(a,2,gl.FLOAT,false,0,0);gl.disable(gl.DEPTH_TEST);gl.disable(gl.CULL_FACE);gl.disable(gl.SCISSOR_TEST);gl.enable(gl.BLEND);gl.blendFunc(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA);gl.activeTexture(gl.TEXTURE0);
      gl.useProgram(program);gl.uniform1f(u.simulated,solver?1:0);
      if(solver){gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,solver.texture);gl.uniform1i(u.simulation,1);gl.activeTexture(gl.TEXTURE0);}
      gl.bindTexture(gl.TEXTURE_2D,texture);
      const source=video.getVideoPlaybackQuality?.().totalVideoFrames??video.currentTime;
      if(source!==lastSource){gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,video);lastSource=source;uploads++;}
      gl.uniform2f(u.viewport,sceneWidth,sceneHeight);gl.uniform2f(u.videoSize,video.videoWidth,video.videoHeight);gl.uniform1f(u.clock,video.currentTime);gl.uniform1f(u.daylight,document.documentElement.dataset.theme==='light'?1:0);gl.uniform2f(u.pointer,point.x,point.y);gl.uniform2f(u.wake,fluid.wx,fluid.wy);gl.uniform2f(u.force,fluid.fx,fluid.fy);gl.uniform1f(u.influence,fluid.amount);
      // Draw the complete deformed environment once into a separate target.
      // Glass then samples that exact frame, never its own output or DOM text.
      gl.activeTexture(gl.TEXTURE2);gl.bindTexture(gl.TEXTURE_2D,null);gl.uniform1i(u.sceneFrame,2);gl.activeTexture(gl.TEXTURE0);gl.uniform1f(u.useSceneFrame,0);gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);gl.viewport(0,0,canvas.width,canvas.height);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(u.surfaceMode,0);gl.uniform2f(u.paneSize,sceneWidth,sceneHeight);gl.drawArrays(gl.TRIANGLES,0,6);
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER,framebuffer);gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER,null);gl.blitFramebuffer(0,0,canvas.width,canvas.height,0,0,canvas.width,canvas.height,gl.COLOR_BUFFER_BIT,gl.NEAREST);gl.bindFramebuffer(gl.FRAMEBUFFER,null);
      gl.activeTexture(gl.TEXTURE2);gl.bindTexture(gl.TEXTURE_2D,frameTexture);gl.activeTexture(gl.TEXTURE0);gl.uniform1f(u.useSceneFrame,1);gl.uniform1f(u.surfaceMode,1);
      for(const p of panes){const sx=canvas.width/sceneWidth,sy=canvas.height/sceneHeight,x0=Math.round(p.x*sx),x1=Math.round((p.x+p.w)*sx),y0=Math.round(p.y*sy),y1=Math.round((p.y+p.h)*sy);gl.viewport(x0,canvas.height-y1,x1-x0,y1-y0);gl.uniform2f(u.paneSize,p.w,p.h);gl.uniform2f(u.paneOrigin,p.x,p.y);gl.uniform1f(u.radius,p.radius);gl.uniform1f(u.tintAmount,p.tint);gl.uniform1f(u.raised,p.raised?1:0);gl.drawArrays(gl.TRIANGLES,0,6);if(!p.e.hasAttribute('data-glass-surface'))p.e.dataset.glassSurface='webgl';
        const front=fronts.get(p.e),front2d=front?.context,frontCanvas=front?.canvas;
        if(front2d){const width=Math.max(1,x1-x0),height=Math.max(1,y1-y0);if(frontCanvas.width!==width||frontCanvas.height!==height){frontCanvas.width=width;frontCanvas.height=height;}front2d.clearRect(0,0,width,height);front2d.drawImage(canvas,x0,y0,width,height,0,0,width,height);frontCanvas.hidden=false;frameCopies++;}
      }
      frames++;canvas.hidden=false;host.dataset.sharedGlass='ready';if(host.dataset.glassStatus!=='ready')host.dataset.glassStatus='ready';lastDrawMs=performance.now()-start;maxDrawMs=Math.max(maxDrawMs,lastDrawMs);
    }
    function tick(now){raf=0;if(disposed)return;const dt=Math.min(.05,(now-(lastTick||now-16.7))/1000);lastTick=now;
      if(interactive()){
        const k=1-Math.exp(-dt/.055),drag=1-Math.exp(-dt/.14),linger=1-Math.exp(-dt/.65),fade=1-Math.exp(-dt/(fluid.target>fluid.amount?.10:.55));
        const vx=(point.tx-point.x)*sceneWidth*.70,vy=(point.ty-point.y)*sceneHeight*.70;
        const length=Math.hypot(vx,vy),cap=length>155?155/length:1;
        fluid.fx+=(vx*cap-fluid.fx)*drag;fluid.fy+=(vy*cap-fluid.fy)*drag;
        point.x+=(point.tx-point.x)*k;point.y+=(point.ty-point.y)*k;
        fluid.wx+=(point.x-fluid.wx)*linger;fluid.wy+=(point.y-fluid.wy)*linger;
        fluid.amount+=(fluid.target-fluid.amount)*fade;
      }
      if(now<followUntil)dirty=true;render();
      if(!raf&&(now<followUntil||(interactive()&&(Math.hypot(point.tx-point.x,point.ty-point.y)>.0006||Math.abs(fluid.target-fluid.amount)>.001||Math.hypot(fluid.fx,fluid.fy)>.08||Math.hypot(fluid.wx-point.x,fluid.wy-point.y)>.001))))raf=requestAnimationFrame(tick);if(!raf)lastTick=0;
    }
    function schedule(){if(!raf&&!disposed)raf=requestAnimationFrame(tick);}
    function invalidate(){dirty=true;schedule();}
    function pointer(event){if(!interactive()||event.pointerType!=='mouse')return;fluid.target=1;solver?.pointer(event.clientX-sceneLeft,event.clientY-sceneTop,performance.now(),sceneWidth,sceneHeight);point.tx=Math.max(-1,Math.min(1,(event.clientX-sceneLeft)/sceneWidth*2-1));point.ty=Math.max(-1,Math.min(1,(event.clientY-sceneTop)/sceneHeight*2-1));schedule();}
    function leave(){if(!interactive())return;solver?.leave();fluid.target=0;point.tx=point.x;point.ty=point.y;schedule();}
    function hover(event){if(event.target.closest?.(selector)){followUntil=performance.now()+380;invalidate();}}
    function seek(){lastSource=-1;invalidate();}
    const mutation=new MutationObserver(records=>{
      const changed=records.filter(r=>r.attributeName!=='style'||!options.geometryTargets||r.target.matches?.(options.geometryTargets));
      if(!changed.length)return;
      // Opening a dialog or changing a class can change selector membership.
      // Merely moving an existing node requires geometry, not a DOM rescan.
      if(changed.some(r=>r.type==='childList'||r.attributeName==='open'||r.attributeName==='class'))registryDirty=true;
      invalidate();
    });
    mutation.observe(document.body,{subtree:true,childList:true,attributes:true,attributeFilter:options.geometryAttributes||['hidden','open','class','data-workspace-view']});
    const theme=new MutationObserver(invalidate);theme.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
    const resize=new ResizeObserver(invalidate);resize.observe(document.body);
    window.addEventListener('resize',invalidate);document.addEventListener('scroll',invalidate,true);document.addEventListener('pointermove',pointer,{passive:true});document.documentElement.addEventListener('pointerleave',leave);document.addEventListener('pointerover',hover,{passive:true});document.addEventListener('pointerout',hover,{passive:true});
    for(const q of [reduce,motion,forced,coarse,mobile])q.addEventListener('change',invalidate);video.addEventListener('loadeddata',seek);video.addEventListener('seeked',seek);
    canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();contextInvalidated=true;cancelAnimationFrame(raf);raf=0;solver?.pause();clearMaterials();host.dataset.glassStatus='context-lost';});
    function inspect(){return {state:host.dataset.glassStatus,frames,uploads,visibleSurfaces:panes.length,registeredSurfaces:nodes.length,width:canvas.width,height:canvas.height,cssViewport:{width:sceneWidth,height:sceneHeight,left:sceneLeft,top:sceneTop},mediaTime:video.currentTime,contextLost:gl.isContextLost(),error:gl.getError(),frameTarget:{width:frameWidth,height:frameHeight},foregroundCopies:frameCopies,foregroundSize:{width:fronts.values().next().value?.canvas.width||0,height:fronts.values().next().value?.canvas.height||0},foregroundSurfaces:fronts.size,solver:solver?.inspect()||null,pointer:{...point,enabled:interactive()},fluid:{...fluid},lastDrawMs,maxDrawMs,surfaces:panes.map(p=>({tag:p.e.className,id:p.e.id,x:p.x,y:p.y,width:p.w,height:p.h}))};}
    render();return{render,inspect,diagnoseSolver(){return solver?.diagnostics()},setRunning(value){running=!!value;if(!running){solver?.pause();point.tx=point.x;point.ty=point.y;}if(performanceReduced())render();else if(available())invalidate();},dispose(){if(disposed)return;disposed=true;cancelAnimationFrame(raf);mutation.disconnect();theme.disconnect();resize.disconnect();window.removeEventListener('resize',invalidate);document.removeEventListener('scroll',invalidate,true);document.removeEventListener('pointermove',pointer);document.documentElement.removeEventListener('pointerleave',leave);document.removeEventListener('pointerover',hover);document.removeEventListener('pointerout',hover);for(const q of [reduce,motion,forced,coarse,mobile])q.removeEventListener('change',invalidate);video.removeEventListener('loadeddata',seek);video.removeEventListener('seeked',seek);clearMaterials();solver?.dispose();gl.deleteBuffer(buffer);gl.deleteTexture(texture);gl.deleteTexture(frameTexture);gl.deleteFramebuffer(framebuffer);gl.deleteProgram(program);for(const front of fronts.values())front.canvas.remove();fronts.clear();canvas.remove();host.dataset.glassStatus='disposed';}};
  }
  window.StudioDreamGlassScene=Object.freeze({create});
})();
