export const glassVertex = `attribute vec2 aPosition;void main(){gl_Position=vec4(aPosition,0.,1.);}`;
export const glassFragment = `
    precision highp float;
    uniform sampler2D uScene;
    uniform sampler2D uIcons;
    uniform vec2 uResolution,uSize,uOrigin,uDocument,uScale,uIconsOrigin,uIconsSize;
    uniform float uDpr,uLens,uLift;
    vec4 scene(vec2 p){return texture2D(uScene,clamp(p/uDocument,vec2(.0001),vec2(.9999)));}
    vec4 icons(vec2 p){vec2 uv=(p-uIconsOrigin)/uIconsSize;
      if(uv.x<0.||uv.y<0.||uv.x>1.||uv.y>1.)return vec4(0.);
      return texture2D(uIcons,uv);}
    void main(){
      vec2 p=vec2(gl_FragCoord.x,uResolution.y-gl_FragCoord.y)/uDpr;
      float radius=min(uSize.x,uSize.y)*.5;
      vec2 center=uSize*.5;
      vec2 q=abs(p-center)-(center-vec2(radius));
      float sdf=length(max(q,0.))+min(max(q.x,q.y),0.)-radius;
      float depth=-sdf;
      float mask=smoothstep(-.6,.65,depth);
      vec2 nearest=clamp(p,vec2(radius),uSize-vec2(radius));
      vec2 n=(p-nearest)/max(length(p-nearest),.001);
      float edge=1.-smoothstep(0.,radius*.8,max(depth,0.));
      float bend=pow(edge,2.1)*mix(9.,18.*uLift,uLens);
      vec2 interior=center+(p-center)*mix(.985,mix(1.,.84,uLift),uLens)-n*bend;
      vec2 source=uOrigin+interior*uScale;
      float dispersion=pow(edge,2.)*mix(.65,1.4,uLens);
      vec2 chroma=n*dispersion;
      vec3 color;
      color.r=scene(source+chroma).r;
      color.g=scene(source).g;
      color.b=scene(source-chroma).b;
      vec3 soft=(scene(source+vec2(.8,0.)).rgb+scene(source-vec2(.8,0.)).rgb+
        scene(source+vec2(0.,.8)).rgb+scene(source-vec2(0.,.8)).rgb)*.25;
      color=mix(color,soft,.22);
      float y=p.y/uSize.y;
      float reflection=exp(-pow((y-.16)/.19,2.));
      color*=1.-reflection*mix(.22,.26,uLens);
      color=mix(color,vec3(.81,.79,.76),mix(.085,.045,uLens));
      color+=vec3(.035)*pow(1.-abs(n.y),7.)*edge;
      float bottom=pow(max(n.y,0.),9.)*pow(edge,5.);
      color+=vec3(.23,.24,.23)*bottom;
      if(uLens<.5){
        vec3 material=mix(vec3(.205,.208,.217),vec3(.105,.108,.115),smoothstep(0.,1.,y));
        color=mix(color,material,mix(.74,.82,smoothstep(.1,1.,y)));
      }
      if(uLens>.5){
        vec3 resting=mix(scene(uOrigin+p*uScale).rgb,vec3(.015,.017,.02),.88);
        color=mix(resting,mix(color,vec3(.12),.2),uLift);
        vec2 uiSource=uOrigin+(center+(p-center)*mix(1.,.84,uLift)-n*pow(edge,3.)*3.*uLift)*uScale;
        vec4 ui=icons(uiSource);
        
        color=mix(color,ui.rgb,ui.a);
      }
      gl_FragColor=vec4(color,mask);
    }`;
