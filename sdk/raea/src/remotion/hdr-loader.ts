// three.js before r180 has HDRLoader under its old name, RGBELoader: raea's R3F reader (sdk/r3f, three >= 0.170)
// imports HDRLoader, so a project on an older three gets it from here (engine/bundle edit.rs)
export { RGBELoader as HDRLoader } from "three/examples/jsm/loaders/RGBELoader.js";
