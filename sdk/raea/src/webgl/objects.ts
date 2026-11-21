// The WebGL object wrappers a context hands out. Each holds the id JS allocated for it (PROTOCOL.md "Object ids": one
// counter per kind per context, from 1) and the context that made it. WebGL's is* answers come from `_bound`/`_deleted`.

export class WebGLObject_ {
  /** bound (or, for shaders, programs and samplers, created) at least once: is* answers true until deleted */
  _bound = false;
  _deleted = false;
  constructor(readonly id: number, readonly _gl: object) {}
}

export class WebGLBuffer_ extends WebGLObject_ {}
export class WebGLRenderbuffer_ extends WebGLObject_ {}
export class WebGLSampler_ extends WebGLObject_ {}
export class WebGLQuery_ extends WebGLObject_ {}
export class WebGLTexture_ extends WebGLObject_ {}

/** what's attached where (attachment enum to texture or renderbuffer), for getFramebufferAttachmentParameter */
export class WebGLFramebuffer_ extends WebGLObject_ {
  _att: Map<number, WebGLTexture_ | WebGLRenderbuffer_> | null = null;
}

/** the ELEMENT_ARRAY_BUFFER binding is the vertex array's */
export class WebGLVertexArrayObject_ extends WebGLObject_ {
  _element: WebGLBuffer_ | null = null;
}

export class WebGLShader_ extends WebGLObject_ {
  _source = "";
  constructor(id: number, gl: object, readonly _type: number) {
    super(id, gl);
  }
}

export class WebGLProgram_ extends WebGLObject_ {
  /** getUniformLocation's answers by name, until the next link */
  _locs = new Map<string, WebGLUniformLocation_ | null>();
  _shaders: WebGLShader_[] = [];
}

export class WebGLUniformLocation_ {
  constructor(readonly id: number, readonly _program: WebGLProgram_) {}
}

export class WebGLActiveInfo_ {
  constructor(readonly name: string, readonly size: number, readonly type: number) {}
}

export class WebGLShaderPrecisionFormat_ {
  constructor(readonly rangeMin: number, readonly rangeMax: number, readonly precision: number) {}
}

/** WebGLRenderingContext (WebGL 1): installed so `x instanceof WebGLRenderingContext` works; nothing is one */
export class WebGLRenderingContext_ {}
