import { WorkerError } from './errors.js';
// Deterministic primitive meshes. The same generated volume is used for both
// engines; these are modifier boundaries, never additional printable objects.
export const modifierGeometry = ({shape, sizeMm}) => {
  const vertices=[],triangles=[];
  const vertex=(x,y,z)=>{vertices.push({x:x*sizeMm.x/2,y:y*sizeMm.y/2,z:z*sizeMm.z/2});return vertices.length-1;};
  if(shape==='box'){
    for(const [x,y,z] of [[-1,-1,-1],[1,-1,-1],[1,1,-1],[-1,1,-1],[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]])vertex(x,y,z);
    for(const t of [[0,2,1],[0,3,2],[4,5,6],[4,6,7],[0,1,5],[0,5,4],[1,2,6],[1,6,5],[2,3,7],[2,7,6],[3,0,4],[3,4,7]])triangles.push(t);
  }else if(shape==='cylinder'){
    const segments=64,bottom=vertex(0,0,-1),top=vertex(0,0,1),lower=[],upper=[];
    for(let i=0;i<segments;i++){const a=2*Math.PI*i/segments;lower.push(vertex(Math.cos(a),Math.sin(a),-1));upper.push(vertex(Math.cos(a),Math.sin(a),1));}
    for(let i=0;i<segments;i++){const j=(i+1)%segments;triangles.push([bottom,lower[j],lower[i]],[top,upper[i],upper[j]],[lower[i],lower[j],upper[j]],[lower[i],upper[j],upper[i]]);}
  }else if(shape==='sphere'){
    const columns=64,rows=32,top=vertex(0,0,1),rings=[];
    for(let row=1;row<rows;row++){const phi=Math.PI*row/rows,ring=[];for(let col=0;col<columns;col++){const theta=2*Math.PI*col/columns;ring.push(vertex(Math.sin(phi)*Math.cos(theta),Math.sin(phi)*Math.sin(theta),Math.cos(phi)));}rings.push(ring);}
    const bottom=vertex(0,0,-1);
    for(let col=0;col<columns;col++){const j=(col+1)%columns;triangles.push([top,rings[0][col],rings[0][j]],[bottom,rings.at(-1)[j],rings.at(-1)[col]]);for(let row=0;row<rings.length-1;row++)triangles.push([rings[row][col],rings[row+1][col],rings[row+1][j]],[rings[row][col],rings[row+1][j],rings[row][j]]);}
  }else throw new WorkerError('Unsupported modifier geometry.',{code:'slicer_modifier_invalid'});
  return {vertices,triangles};
};
