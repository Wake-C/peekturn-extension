// Shared Peekturn Lucide geometry, 24px grid and rounded 1.8px strokes.
// See licenses/LICENSE-Lucide.txt. Paths match the Android PeekturnIcons family.
const paths={
  copy:['M11 9h9a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2Z','M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1'],
  check:['M20 6 9 17l-5-5'],
  speaker:['M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298Z','M16 9a5 5 0 0 1 0 6','M19.364 18.364a9 9 0 0 0 0-12.728'],
  stop:['M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z'],
  close:['M18 6 6 18','m6 6 12 12'],
  play:['M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19Z'],
  settings:['M14 17H5','M19 7h-9','M14 17a3 3 0 1 0 6 0a3 3 0 1 0-6 0Z','M4 7a3 3 0 1 0 6 0a3 3 0 1 0-6 0Z'],
  contents:['M3 5h.01','M3 12h.01','M3 19h.01','M8 5h13','M8 12h13','M8 19h13'],
  follow:['M9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0Z','M3 7V5a2 2 0 0 1 2-2h2','M17 3h2a2 2 0 0 1 2 2v2','M21 17v2a2 2 0 0 1-2 2h-2','M7 21H5a2 2 0 0 1-2-2v-2'],
  replay:['M3 10a9 9 0 1 1 2.6 8.4','M3 4v6h6'],
  reload:['M3 12a9 9 0 0 1 15.4-6.4L21 8','M21 3v5h-5','M21 12a9 9 0 0 1-15.4 6.4L3 16','M8 16H3v5']
};
export function icon(name){
  const ns='http://www.w3.org/2000/svg';
  const svg=document.createElementNS(ns,'svg');
  for(const [key,value] of Object.entries({viewBox:'0 0 24 24',width:'20',height:'20',fill:'none',stroke:'currentColor','stroke-width':'1.8','stroke-linecap':'round','stroke-linejoin':'round','aria-hidden':'true',focusable:'false'}))svg.setAttribute(key,value);
  for(const d of paths[name]){const path=document.createElementNS(ns,'path');path.setAttribute('d',d);svg.append(path);}
  return svg;
}
