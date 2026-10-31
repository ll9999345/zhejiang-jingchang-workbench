/* ZHEJIANG / LIQUID STUDIO — self-contained blue/violet light field.
 * Theme palette follows the real workbench; renderer lifecycle is preserved.
 * No external assets, libraries, network requests, telemetry or product APIs.
 * An independent WebGL2 context is used only while the opening is visible.
 */
(function (global) {
  'use strict';
  const VERT = `#version 300 es
    in vec2 aPosition;
    out vec2 uv;
    void main() { uv = aPosition * .5 + .5; gl_Position = vec4(aPosition, 0., 1.); }
  `;
  const FRAG = `#version 300 es
    precision mediump float;
    in vec2 uv;
    out vec4 color;
    uniform vec2 uResolution;
    uniform float uTime;
    uniform float uProgress;
    uniform vec2 uPointer;
    float lobe(vec2 p, vec2 center, vec2 radius) {
      vec2 d=(p-center)/radius;
      return exp(-dot(d,d)*2.8);
    }
    void main() {
      float aspect=uResolution.x/max(1.,uResolution.y);
      vec2 p=vec2(uv.x,1.-uv.y);
      vec2 q=(p-.5)*vec2(aspect,1.);
      q+=(uPointer-.5)*vec2(.021,.012);
      float t=uTime*.15;
      q/=1.+.09*smoothstep(.21,.9,uProgress);
      q+=vec2(sin(q.y*3.2+t),cos(q.x*2.4-t))*.065;
      vec2 a=vec2(aspect*.22+sin(t)*.03,-.16+cos(t)*.04);
      vec2 b=vec2(-aspect*.08+cos(t*.9)*.04,.25+sin(t)*.03);
      vec3 c=vec3(.043,.043,.114);
      c+=vec3(.537,.325,1.)*lobe(q,a,vec2(aspect*.43,.57))*.34;
      c+=vec3(.188,.357,.957)*lobe(q,b,vec2(aspect*.52,.56))*.32;
      c+=vec3(.141,.557,1.)*lobe(q,vec2(aspect*.38,.12),vec2(aspect*.31,.40))*.12;
      c+=vec3(.780,.678,1.)*lobe(q,vec2(aspect*.18,-.23),vec2(aspect*.20,.25))*.075;
      // Wide, continuous meniscus highlights; no terrain, grain or particles.
      float edge=abs(length((q-a)/vec2(aspect*.30,.32))-1.);
      float rim=exp(-edge*52.);
      c+=vec3(.831,.769,1.)*rim*.032;
      float vignette=1.-smoothstep(.28,1.,length((p-.5)*vec2(1.2,1.)));
      c*=mix(.67,1.,vignette);
      color=vec4(pow(max(c,0.),vec3(.96)),1.);
    }
  `;
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  function makeShader(gl, type, source) {
    const shader=gl.createShader(type);
    gl.shaderSource(shader,source); gl.compileShader(shader);
    if (!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) {
      const message=gl.getShaderInfoLog(shader);
      gl.deleteShader(shader); throw Error(message || 'GLSL compile failure');
    }
    return shader;
  }
  class Terrain {
    constructor(canvas, options={}) {
      this.canvas=canvas; this.options=options; this.kind='css-static';
      this.gl=null; this.ctx=null; this.program=null; this.buffer=null;
      this.lost=false; this.disposed=false; this.lastW=0; this.lastH=0;
      const requested=options.renderer || 'auto';
      if(requested==='static') return;
      if(requested!=='2d' && requested!=='fail') {
        try { this.setupGL(); } catch(error) {
          options.onFallback?.('webgl-init-failed');
          this.disposeGL();
          // A canvas that claimed a WebGL context cannot also obtain 2D.
          const next=canvas.cloneNode(false);
          canvas.replaceWith(next); this.canvas=next;
        }
      }
      if(!this.gl) {
        try { this.ctx=this.canvas.getContext('2d',{alpha:false}); } catch { this.ctx=null; }
        this.kind=this.ctx?'canvas2d':'css-static';
      }
    }
    setupGL() {
      const gl=this.canvas.getContext('webgl2',{alpha:false,antialias:false,
        depth:false,stencil:false,preserveDrawingBuffer:false,powerPreference:'low-power'});
      if(!gl) throw Error('webgl2 unavailable');
      this.gl=gl;
      const vertex=makeShader(gl,gl.VERTEX_SHADER,VERT);
      const fragment=makeShader(gl,gl.FRAGMENT_SHADER,FRAG);
      const program=gl.createProgram();
      gl.attachShader(program,vertex); gl.attachShader(program,fragment); gl.linkProgram(program);
      gl.deleteShader(vertex);gl.deleteShader(fragment);
      if(!gl.getProgramParameter(program,gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(program));
      this.program=program;
      const buffer=gl.createBuffer(); this.buffer=buffer;
      gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
      gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);
      const attr=gl.getAttribLocation(program,'aPosition');
      gl.enableVertexAttribArray(attr);gl.vertexAttribPointer(attr,2,gl.FLOAT,false,0,0);
      this.uniforms={resolution:gl.getUniformLocation(program,'uResolution'),
        time:gl.getUniformLocation(program,'uTime'),
        progress:gl.getUniformLocation(program,'uProgress'),
        pointer:gl.getUniformLocation(program,'uPointer')};
      this.onLost=(ev)=>{ ev.preventDefault();this.lost=true;this.options.onContextLost?.(); };
      this.canvas.addEventListener('webglcontextlost',this.onLost);
      this.kind='webgl2';
    }
    resize() {
      const w=window.innerWidth||1280, h=window.innerHeight||720;
      let scale=Math.min(window.devicePixelRatio||1, w<=640?.88:1.22);
      scale=Math.min(scale, 1460/w, 980/h);
      const cw=Math.max(1,Math.round(w*scale)),ch=Math.max(1,Math.round(h*scale));
      if(this.lastW===cw&&this.lastH===ch) return;
      this.lastW=cw;this.lastH=ch;this.canvas.width=cw;this.canvas.height=ch;
      if(this.gl&&!this.lost) this.gl.viewport(0,0,cw,ch);
    }
    render({time=0,progress=0,pointer={x:.5,y:.5}}={}) {
      if(this.disposed||this.kind==='css-static'||this.lost) return;
      this.resize();
      if(this.gl) {
        const gl=this.gl;
        gl.useProgram(this.program);
        gl.uniform2f(this.uniforms.resolution,this.lastW,this.lastH);
        gl.uniform1f(this.uniforms.time,time);
        gl.uniform1f(this.uniforms.progress,clamp(progress,0,1));
        gl.uniform2f(this.uniforms.pointer, pointer.x, pointer.y);
        gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
      } else if(this.ctx) this.render2D(time,progress,pointer);
    }
    render2D(time, progress, pointer) {
      const ctx=this.ctx,w=this.lastW,h=this.lastH;
      ctx.setTransform(1,0,0,1,0,0);
      ctx.fillStyle='#0b0b1d';ctx.fillRect(0,0,w,h);
      const drift=Math.sin(time*.15)*.025;
      const lookX=(pointer.x-.5)*.012,lookY=(pointer.y-.5)*.008;
      const zoom=1.+progress*.045;
      const glow=(x,y,rx,ry,inner,outer)=>{
        ctx.save();ctx.translate(w*(x+lookX),h*(y+lookY));ctx.scale(w*rx*zoom,h*ry*zoom);
        const light=ctx.createRadialGradient(0,0,0,0,0,1);
        light.addColorStop(0,inner);light.addColorStop(.45,outer);light.addColorStop(1,'rgba(11,11,29,0)');
        ctx.fillStyle=light;ctx.fillRect(-1,-1,2,2);ctx.restore();
      };
      glow(.72+drift,.30,.46,.59,'rgba(137,83,255,.40)','rgba(137,83,255,.16)');
      glow(.43-drift,.75,.54,.60,'rgba(48,91,244,.38)','rgba(48,91,244,.13)');
      glow(.88,.59,.32,.42,'rgba(36,142,255,.17)','rgba(36,142,255,.05)');
      glow(.66,.23,.23,.31,'rgba(199,173,255,.16)','rgba(199,173,255,.04)');
      // A continuous lens edge carries the glass material into the cheap 2D path.
      ctx.strokeStyle='rgba(208,201,255,.12)';ctx.lineWidth=.8;
      ctx.beginPath();ctx.ellipse(w*(.72+drift+lookX),h*(.30+lookY),w*.30,h*.32,-.18,0,Math.PI*2);ctx.stroke();
    }
    disposeGL() {
      if(!this.gl) return;
      const gl=this.gl;
      try {
        if(this.onLost) this.canvas.removeEventListener('webglcontextlost',this.onLost);
        if(this.buffer) gl.deleteBuffer(this.buffer);
        if(this.program) gl.deleteProgram(this.program);
        gl.getExtension('WEBGL_lose_context')?.loseContext();
      } catch { /* A lost context is already released. */ }
      this.gl=null;this.program=null;this.buffer=null;
    }
    dispose() {
      if(this.disposed) return;
      this.disposed=true;this.disposeGL();this.ctx=null;
      if(this.canvas){this.canvas.width=1;this.canvas.height=1;}
    }
  }
  global.ZJTerrainRenderer=Object.freeze({create(canvas,options){return new Terrain(canvas,options);}});
})(window);
