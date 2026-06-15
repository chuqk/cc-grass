import type { Theme } from "./svg.js";

export interface ChartDataEntry {
  date: string;
  models: Record<string, number>;
}

export interface HtmlOptions {
  title?: string;
  theme?: Theme;
  chartData?: ChartDataEntry[];
  chartSince?: string;
  chartUntil?: string;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return c;
    }
  });
}

export function renderHtml(svgContent: string, opts: HtmlOptions = {}): string {
  const title = opts.title ?? "cc-grass";
  const theme = opts.theme ?? "dark";
  const bg = theme === "dark" ? "#0d1117" : "#ffffff";
  const fg = theme === "dark" ? "#c9d1d9" : "#1f2328";
  const chartData = opts.chartData;

  const chartSince = opts.chartSince ?? "";
  const chartUntil = opts.chartUntil ?? "";

  const chartSection =
    chartData && chartData.length > 0
      ? `<div id="cc-chart" style="max-width:100%;overflow-x:auto;margin-top:32px"></div>
<script>
window.__CC_CHART=${JSON.stringify(chartData)};
window.__CC_THEME="${theme}";
window.__CC_SINCE="${chartSince}";
window.__CC_UNTIL="${chartUntil}";
${chartJs()}
</script>`
      : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
  html, body { margin: 0; padding: 0; }
  body {
    background: ${bg};
    color: ${fg};
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: 24px;
    box-sizing: border-box;
  }
  .cc-grass-wrap { max-width: 100%; overflow-x: auto; }
  .cc-grass-wrap svg rect[data-date]:hover {
    stroke: ${theme === "dark" ? "#ffffff" : "#1f2328"};
    stroke-width: 1;
    cursor: default;
  }
  #cc-chart svg rect[data-week] { cursor: default; }
  #cc-chart svg rect[data-week]:hover { opacity: 0.85; }
</style>
</head>
<body>
<div class="cc-grass-wrap">
${svgContent}
</div>
${chartSection}
</body>
</html>
`;
}

function chartJs(): string {
  // The chart SVG mirrors the grass SVG layout (constants from svg.ts)
  // so bars align pixel-perfectly with the heatmap cells above.
  return `(function(){
var D=window.__CC_CHART;
if(!D||!D.length)return;
var isDark=window.__CC_THEME==='dark';
var C={
  text:isDark?'#7d8590':'#57606a',
  bold:isDark?'#c9d1d9':'#1f2328',
  border:isDark?'#30363d':'#d0d7de',
  bg:isDark?'#0d1117':'#ffffff',
  grid:isDark?'#21262d':'#d0d7de',
  tipBg:isDark?'#1c2128':'#ffffff',
  tipBorder:isDark?'#30363d':'#d0d7de',
  cellStroke:isDark?'rgba(255,255,255,0.05)':'rgba(27,31,36,0.06)'
};
var CELL=10,GAP=3,STRIDE=13;
var BPAD=16,OPAD=8,LPAD=28,HEADER_H=32;
var gridLeft=OPAD+BPAD+LPAD;
var PAL={
  'Fable 5':'#f9a8d4','Fable 5.1':'#f472b6',
  'Opus 4.5':'#ffcb8b','Opus 4.6':'#ff9c47','Opus 4.7':'#f97316','Opus 4.8':'#c2410c',
  'Sonnet 4.5':'#93c5fd','Sonnet 4.6':'#3b82f6',
  'Haiku 4.5':'#86efac','Haiku 4.6':'#22c55e',
  'Synthetic':'#4b5563'
};
var EX=['#6b7280','#9ca3af','#fbbf24','#f472b6'];
var ei=0;
function gc(n){return PAL[n]||(PAL[n]=EX[ei++%EX.length]);}
function norm(r){
  var s=r.replace(/\\[.*\\]$/,'');
  if(s==='<synthetic>')return'Synthetic';
  var m=s.match(/^claude-(\\w+)-(.+)$/);
  if(!m)return r;
  return m[1][0].toUpperCase()+m[1].slice(1)+' '+m[2].replace(/-\\d{8}$/,'').replace(/-/g,'.');
}
function fmt(n){
  if(n<1000)return String(Math.round(n));
  if(n<1e6)return(n/1e3).toFixed(0)+'k';
  if(n<1e9)return(n/1e6).toFixed(1).replace(/\\.0$/,'')+'m';
  return(n/1e9).toFixed(1).replace(/\\.0$/,'')+'b';
}
var wm={};
D.forEach(function(d){
  var dt=new Date(d.date+'T12:00:00');
  var sun=new Date(dt);sun.setDate(dt.getDate()-dt.getDay());
  var k=sun.toISOString().slice(0,10);
  if(!wm[k])wm[k]={};
  Object.keys(d.models).forEach(function(raw){
    var n=norm(raw);wm[k][n]=(wm[k][n]||0)+d.models[raw];
  });
});
var allWeekKeys=[];
if(window.__CC_SINCE&&window.__CC_UNTIL){
  var sd=new Date(window.__CC_SINCE+'T12:00:00');
  sd.setDate(sd.getDate()-sd.getDay());
  var ed=new Date(window.__CC_UNTIL+'T12:00:00');
  while(sd<=ed){allWeekKeys.push(sd.toISOString().slice(0,10));sd.setDate(sd.getDate()+7);}
}else{
  allWeekKeys=Object.keys(wm).sort();
}
var weeks=allWeekKeys.map(function(k){return{week:k,models:wm[k]||{}};});
if(!weeks.length)return;
var totals={};
weeks.forEach(function(w){
  Object.keys(w.models).forEach(function(m){totals[m]=(totals[m]||0)+w.models[m];});
});
var FAM_ORD={'Fable':0,'Opus':1,'Sonnet':2,'Haiku':3};
function mfam(n){return n.split(' ')[0]||'?';}
function mver(n){return parseFloat(n.split(' ')[1])||0;}
var models=Object.keys(totals).sort(function(a,b){
  var fa=FAM_ORD[mfam(a)],fb=FAM_ORD[mfam(b)];
  if(fa===undefined)fa=99;if(fb===undefined)fb=99;
  if(fa!==fb)return fa-fb;
  return mver(b)-mver(a);
});
var gs=document.querySelector('.cc-grass-wrap svg');
var svgW=gs?+gs.getAttribute('width'):762;
var gridRight=gridLeft+weeks.length*STRIDE-GAP;
var legItems=models.map(function(m){
  var label=m+' ('+fmt(totals[m])+')';
  return{m:m,label:label,w:CELL+5+label.length*6.2+16};
});
var legAvailW=gridRight-gridLeft+GAP;
var legRowsArr=[],curRow=[],curW=0;
legItems.forEach(function(item){
  if(curW+item.w>legAvailW&&curRow.length>0){legRowsArr.push({items:curRow,w:curW-16});curRow=[];curW=0;}
  curRow.push(item);curW+=item.w;
});
if(curRow.length>0)legRowsArr.push({items:curRow,w:curW-16});
var CHART_H=200;
var barTop=OPAD+HEADER_H+BPAD+6;
var barBot=barTop+CHART_H;
var monthY=barBot+16;
var legY=monthY+20;
var legRowH=18;
var borderBot=legY+legRowsArr.length*legRowH+2;
var totalH=borderBot+OPAD;
var borderX=OPAD,borderY2=OPAD+HEADER_H;
var borderW=svgW-2*OPAD,borderH=borderBot-borderY2;
var maxS=0;
weeks.forEach(function(w){var s=0;Object.keys(w.models).forEach(function(m){s+=w.models[m];});if(s>maxS)maxS=s;});
if(!maxS)return;
var ns='http://www.w3.org/2000/svg';
function el(tag,a){var e=document.createElementNS(ns,tag);Object.keys(a).forEach(function(k){e.setAttribute(k,String(a[k]));});return e;}
var FONT="-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
var svg=el('svg',{width:svgW,height:totalH,viewBox:'0 0 '+svgW+' '+totalH,'font-family':FONT});
svg.appendChild(el('rect',{width:svgW,height:totalH,fill:C.bg}));
svg.appendChild(el('rect',{x:borderX,y:borderY2,width:borderW,height:borderH,rx:6,ry:6,fill:C.bg,stroke:C.border}));
var titleEl=el('text',{x:OPAD,y:OPAD+18,fill:C.bold,'font-size':'14','font-weight':'400'});
titleEl.textContent='Token usage by model';
svg.appendChild(titleEl);
var ticks=4;
for(var i=0;i<=ticks;i++){
  var v=(maxS/ticks)*i;
  var y=barTop+CHART_H-(v/maxS)*CHART_H;
  svg.appendChild(el('line',{x1:gridLeft,x2:gridRight,y1:y,y2:y,stroke:C.grid,'stroke-dasharray':i===0?'none':'2,2'}));
  if(i>0){var t=el('text',{x:gridLeft-6,y:y+4,fill:C.text,'font-size':'11','text-anchor':'end'});t.textContent=fmt(v);svg.appendChild(t);}
}
var MON=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
var lastMon=-1;
weeks.forEach(function(w,idx){
  var x=gridLeft+idx*STRIDE;
  var yPos=barBot;
  var dt=new Date(w.week+'T12:00:00');
  var mon=dt.getMonth();
  if(mon!==lastMon){lastMon=mon;var ml=el('text',{x:x,y:monthY,fill:C.text,'font-size':'12'});ml.textContent=MON[mon];svg.appendChild(ml);}
  models.forEach(function(model){
    var tokens=w.models[model]||0;
    if(!tokens)return;
    var h=Math.max(0.5,(tokens/maxS)*CHART_H);
    yPos-=h;
    var rect=el('rect',{x:x,y:yPos,width:CELL,height:h,fill:gc(model),rx:'1','data-week':String(idx),'data-model':model});
    svg.appendChild(rect);
  });
});
var legGs=[];
var ly=legY;
legRowsArr.forEach(function(row){
  var g=document.createElementNS(ns,'g');
  var lx=gridLeft;
  row.items.forEach(function(item){
    g.appendChild(el('rect',{x:lx,y:ly-8,width:CELL,height:CELL,rx:2,fill:gc(item.m),stroke:C.cellStroke}));
    var lt=el('text',{x:lx+CELL+5,y:ly+1,fill:C.text,'font-size':'11'});
    lt.textContent=item.label;g.appendChild(lt);
    lx+=item.w;
  });
  svg.appendChild(g);legGs.push(g);
  ly+=legRowH;
});
var tip=document.createElement('div');
tip.style.cssText='position:fixed;display:none;pointer-events:none;background:'+C.tipBg+';border:1px solid '+C.tipBorder+';border-radius:6px;padding:8px 12px;font-size:12px;color:'+C.bold+';z-index:9999;white-space:pre;line-height:1.6;box-shadow:0 2px 8px rgba(0,0,0,0.3);';
document.body.appendChild(tip);
svg.addEventListener('mousemove',function(e){
  var tgt=e.target;
  if(tgt.tagName==='rect'&&tgt.hasAttribute('data-week')){
    var wi=+tgt.getAttribute('data-week');
    var hm=tgt.getAttribute('data-model');
    var w=weeks[wi];if(!w)return;
    var total=0;Object.keys(w.models).forEach(function(m){total+=w.models[m];});
    var lines=[w.week+' \\u2014 '+fmt(total)+' total'];
    models.forEach(function(m){
      if(!w.models[m])return;
      var pct=Math.round(w.models[m]/total*100);
      var pre=m===hm?'\\u25b8 ':'  ';
      lines.push(pre+m+': '+fmt(w.models[m])+' ('+pct+'%)');
    });
    tip.textContent=lines.join('\\n');
    tip.style.display='block';
    var tx=e.clientX+14;
    var ty=e.clientY-10;
    if(tx+tip.offsetWidth>window.innerWidth-8)tx=e.clientX-tip.offsetWidth-14;
    if(ty+tip.offsetHeight>window.innerHeight-8)ty=e.clientY-tip.offsetHeight-10;
    tip.style.left=tx+'px';tip.style.top=ty+'px';
  }
});
svg.addEventListener('mouseleave',function(){tip.style.display='none';});
document.getElementById('cc-chart').appendChild(svg);
legGs.forEach(function(g){
  var bb=g.getBBox();
  var dx=Math.round((legAvailW-(bb.width-gridLeft+bb.x))/2);
  if(dx>0)g.setAttribute('transform','translate('+dx+',0)');
});
})();`;
}
