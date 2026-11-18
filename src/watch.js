import {normalizeCues, mergeWindows, applyEndIds, cueAt} from './captions.js';
import {icon} from './icons.js';

const css = await fetch(chrome.runtime.getURL('src/watch.css')).then(r => r.text());
const send = async message => {
  try { return await chrome.runtime.sendMessage(message); }
  catch { return {ok:false,error:'Peekturn was updated. Reload this YouTube page.'}; }
};
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(text, action, label = text) {
  const node = element('button', '', text);
  node.type = 'button'; node.setAttribute('aria-label', label);
  node.addEventListener('click', action); return node;
}
function iconButton(name,label,action){
  const node=button('',action,label);node.className='icon-button';node.title=label;node.append(icon(name));return node;
}
function shadow(host) {
  const root = host.attachShadow({mode:'open'});
  root.append(element('style', '', css)); return root;
}
const timestamp = ms => {
  const seconds = Math.floor(ms / 1000);
  return seconds >= 3600 ? `${Math.floor(seconds/3600)}:${String(Math.floor(seconds/60)%60).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}` : `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;
};
let session;
let settings = (await send({type:'settings:get'})).settings || {merge:true,autoPronounce:true,accent:'US',language:'en'};

class WatchSession {
  constructor(videoId, player, video, sidebar) {
    this.videoId=videoId; this.player=player; this.video=video; this.raw=[]; this.cues=[];
    this.merged=null; this.alive=true; this.active=-1; this.following=true; this.lookupGeneration=0;
    this.abort=new AbortController(); this.rows=[];
    this.overlay=element('div'); this.overlay.id='peekturn-player';
    Object.assign(this.overlay.style,{position:'absolute',inset:'0',pointerEvents:'none',zIndex:'61'});
    player.append(this.overlay); this.root=shadow(this.overlay);
    this.toolbar=element('div','toolbar');
    this.showPanel=iconButton('contents','Show transcript',()=>{this.panelHost.hidden=!this.panelHost.hidden;this.showPanel.setAttribute('aria-expanded',String(!this.panelHost.hidden));});
    this.showPanel.setAttribute('aria-expanded','true');
    this.toolbar.append(this.showPanel,iconButton('settings','Open Peekturn settings',()=>send({type:'options:open'})));
    this.caption=element('div','caption'); this.caption.setAttribute('aria-label','Peekturn subtitles');
    this.root.append(this.toolbar,this.caption);
    player.addEventListener('pointerenter',()=>this.toolbar.classList.add('visible'),{signal:this.abort.signal});
    player.addEventListener('pointerleave',()=>this.toolbar.classList.remove('visible'),{signal:this.abort.signal});
    this.panelHost=element('div');this.panelHost.id='peekturn-transcript'; sidebar.prepend(this.panelHost);
    this.panelRoot=shadow(this.panelHost); const panel=element('section','panel');panel.setAttribute('aria-label','Peekturn transcript');
    const heading=element('header','panel-header'),actions=element('div','panel-actions');
    this.copyButton=iconButton('copy','Copy transcript',()=>this.copyTranscript());this.copyButton.disabled=true;
    this.followButton=iconButton('follow','Follow playback',()=>{this.setFollowing(true);this.scrollActive();});
    this.setFollowing(true);
    actions.append(this.copyButton,this.followButton,iconButton('close','Hide transcript',()=>{this.panelHost.hidden=true;this.showPanel.setAttribute('aria-expanded','false');}));
    heading.append(element('h2','','Transcript'),actions);
    this.copyFeedback=element('div','copy-feedback visually-hidden');this.copyFeedback.setAttribute('role','status');
    this.status=element('div','status','Loading English captions…');this.status.setAttribute('role','status');
    this.list=element('div','transcript-list');this.list.tabIndex=0;this.list.setAttribute('aria-label','Complete transcript');
    const stopFollow=()=>this.setFollowing(false);
    this.list.addEventListener('wheel',stopFollow,{passive:true});this.list.addEventListener('touchmove',stopFollow,{passive:true});
    this.list.addEventListener('keydown',e=>{if(['ArrowDown','ArrowUp','PageDown','PageUp','Home','End'].includes(e.key))stopFollow();});
    const footer=element('footer','panel-footer');footer.append(iconButton('reload','Reload captions',()=>this.request()),iconButton('settings','Open Peekturn settings',()=>send({type:'options:open'})));
    panel.append(heading,this.copyFeedback,this.status,this.list,footer);this.panelRoot.append(panel);
    this.root.addEventListener('keydown',e=>{e.stopPropagation();if(e.key==='Escape')this.closeLookup();});
    this.panelRoot.addEventListener('keydown',e=>e.stopPropagation());
    this.root.addEventListener('click',e=>e.stopPropagation());
    document.addEventListener('click',event=>this.dismissFromOutside(event),{capture:true,signal:this.abort.signal});
    this.onCaptions=e=>this.receive(e.detail);
    document.addEventListener('peekturn:captions',this.onCaptions,{signal:this.abort.signal});
    video.addEventListener('timeupdate',()=>this.sync(),{signal:this.abort.signal});
    video.addEventListener('seeked',()=>this.sync(),{signal:this.abort.signal});
    this.resize=new ResizeObserver(()=>this.positionLookup());
    this.resize.observe(this.overlay);this.resize.observe(this.caption);
    this.request();
  }
  setFollowing(enabled){
    this.following=enabled;this.followButton.setAttribute('aria-pressed',String(enabled));
    this.followButton.title=enabled?'Following playback':'Follow playback';
  }
  async copyTranscript(){
    if(this.copying||!this.cues.length)return;
    this.copying=true;this.copyButton.disabled=true;clearTimeout(this.copyReset);
    this.copyButton.replaceChildren(icon('copy'));this.copyButton.title='Copy transcript';this.copyButton.setAttribute('aria-label','Copy transcript');
    this.copyFeedback.textContent='';
    try{
      await navigator.clipboard.writeText(this.cues.map(cue=>cue.text).join('\n'));
      if(!this.alive)return;
      this.copyButton.replaceChildren(icon('check'));
      this.copyButton.title='Transcript copied';this.copyButton.setAttribute('aria-label','Transcript copied');
      this.copyFeedback.className='copy-feedback visually-hidden';this.copyFeedback.textContent='Transcript copied';
      this.copyReset=setTimeout(()=>{
        this.copyButton.replaceChildren(icon('copy'));
        this.copyButton.title='Copy transcript';this.copyButton.setAttribute('aria-label','Copy transcript');
        this.copyFeedback.textContent='';
      },1800);
    }catch{
      if(this.alive){
        this.copyFeedback.className='copy-feedback error';
        this.copyFeedback.textContent='Could not copy transcript. Try again.';
      }
    }finally{
      this.copying=false;
      if(this.alive)this.copyButton.disabled=!this.cues.length;
    }
  }
  request() {
    this.requestId=crypto.randomUUID();this.status.textContent='Loading English captions…';
    clearTimeout(this.captionTimeout);
    this.captionTimeout=setTimeout(()=>{if(this.alive)this.status.textContent='Captions did not load. Turn on YouTube captions, then reload captions here.';},18000);
    document.dispatchEvent(new CustomEvent('peekturn:request',{detail:{videoId:this.videoId,requestId:this.requestId}}));
  }
  receive(data) {
    if(!this.alive || !data || data.videoId!==this.videoId || data.requestId!==this.requestId)return;
    clearTimeout(this.captionTimeout);
    if(data.error){this.status.textContent=data.error;return;}
    try { this.raw=normalizeCues(data.cues); }
    catch {this.status.textContent='YouTube returned captions in an unsupported format.';return;}
    if(!this.raw.length){this.status.textContent='No English captions are available for this video.';return;}
    this.mergeGeneration=(this.mergeGeneration||0)+1;this.merging=false;this.merged=null;this.mergeError=null;this.mergeCacheUnavailable=false;
    if(!this.nativeStyle){this.nativeStyle=element('style');this.nativeStyle.textContent='#movie_player .ytp-caption-window-container{visibility:hidden!important}';document.head.append(this.nativeStyle);}
    this.selectCues();
  }
  selectCues(preserveLookup=false) {
    if(!settings.merge&&this.merging){
      this.mergeGeneration=(this.mergeGeneration||0)+1;this.merging=false;
    }
    this.cues=settings.merge&&this.merged?this.merged:this.raw;
    this.copyButton.disabled=this.copying||!this.cues.length;
    if(!preserveLookup)this.closeLookup();
    this.active=-1;this.rows=[];this.list.replaceChildren();
    const fragment=document.createDocumentFragment();
    this.cues.forEach((cue,index)=>{
      const row=element('div','cue');
      const seek=button(timestamp(cue.startMs),()=>{this.closeLookup();this.video.currentTime=cue.startMs/1000;this.setFollowing(true);this.sync();},`Seek to ${timestamp(cue.startMs)}`);seek.className='timestamp';
      const text=element('p');this.fillWords(text,cue,index);row.append(seek,text);fragment.append(row);this.rows.push(row);
    });
    this.list.append(fragment);this.sync();
    this.updateStatus();if(settings.merge&&!this.merged&&!this.merging&&!this.mergeError&&this.raw.length)void this.merge();
  }
  updateStatus() {
    if(!this.raw.length)return;
    this.status.textContent=!settings.merge?'Original captions':this.merged?`${this.cues.length} sentences${this.mergeCacheUnavailable?' · not cached':''}`:this.mergeError?`${this.mergeError} Original captions shown.`:this.merging?'Merging sentences… Original captions shown.':'Preparing sentence captions…';
  }
  async merge() {
    this.merging=true;this.mergeCacheUnavailable=false;const generation=this.mergeGeneration;const source=this.raw;const boundaries=[];this.updateStatus();
    try {
      const windows=mergeWindows(source);
      for(let i=0;i<windows.length;i++) {
        if(!this.alive||generation!==this.mergeGeneration)return;
        const result=await send({type:'merge',videoId:this.videoId,cues:windows[i]});
        if(!this.alive||generation!==this.mergeGeneration)return;
        if(!result?.ok)throw new Error(result?.error||'Sentence merging failed.');
        if(result.cache==='unavailable')this.mergeCacheUnavailable=true;
        boundaries.push(...result.endCueIds);
        this.status.textContent=`Merging sentences ${i+1}/${windows.length}… Original captions shown.`;
      }
      this.merged=applyEndIds(source,boundaries);
      if(!this.merged)throw new Error('The model returned invalid sentence boundaries.');
    }catch(error){this.mergeError=error.message;}
    if(this.alive&&generation===this.mergeGeneration){this.merging=false;this.selectCues(true);}
  }
  fillWords(node,cue,index) {
    const pattern=/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu;let offset=0;
    for(const match of cue.text.matchAll(pattern)){
      node.append(document.createTextNode(cue.text.slice(offset,match.index)));
      const word=button(match[0],()=>this.lookup(match[0],cue,index,match.index,word));word.className='word';word.dataset.offset=String(match.index);word.dataset.cue=String(index);node.append(word);offset=match.index+match[0].length;
    }
    node.append(document.createTextNode(cue.text.slice(offset)));
  }
  sync() {
    if(!this.alive)return;
    const index=cueAt(this.cues,this.video.currentTime*1000);
    if(index===this.active)return;
    this.rows[this.active]?.classList.remove('active');this.rows[this.active]?.removeAttribute('aria-current');
    this.active=index;this.caption.replaceChildren();
    if(index>=0&&this.cues[index]){const line=element('span','caption-line');this.fillWords(line,this.cues[index],index);this.caption.append(line);this.rows[index]?.classList.add('active');this.rows[index]?.setAttribute('aria-current','true');if(this.following)this.scrollActive();}
  }
  scrollActive() {
    const row=this.rows[this.active];if(!row)return;
    this.list.scrollTop=Math.max(0,row.offsetTop-this.list.offsetTop-this.list.clientHeight/3);
  }
  positionLookup(){
    if(!this.popup)return;
    const top=parseFloat(getComputedStyle(this.popup).top);
    const captionTop=this.caption.childElementCount?this.caption.offsetTop:this.overlay.clientHeight-60;
    this.popup.style.maxHeight=`${Math.max(100,captionTop-top-12)}px`;
  }
  closeLookup() {
    this.speechGeneration=(this.speechGeneration||0)+1;this.speakingText=null;
    this.lookupGeneration++;this.popup?.remove();this.popup=null;
    this.root.querySelectorAll('.selected').forEach(n=>n.classList.remove('selected'));this.panelRoot.querySelectorAll('.selected').forEach(n=>n.classList.remove('selected'));
    void send({type:'speech:stop'});
  }
  dismissFromOutside(event){
    if(!this.popup)return;
    const path=event.composedPath();
    if(path.includes(this.popup)||path.some(node=>node.classList?.contains('word')&&
      (node.getRootNode()===this.root||node.getRootNode()===this.panelRoot)))return;
    const resume=this.lookupWasPlaying;
    const navigating=path.some(node=>node.matches?.('a[href]'));
    this.closeLookup();
    // Let the clicked transport/seek control act first, without toggling playback twice.
    if(resume&&!navigating)setTimeout(()=>{
      if(this.alive&&!this.popup&&this.video.paused&&
        new URLSearchParams(location.search).get('v')===this.videoId){
        void this.video.play().catch(()=>{});
      }
    },0);
  }
  async lookup(word,cue,index,offset,trigger) {
    const resume=this.popup?this.lookupWasPlaying:!this.video.paused;
    this.closeLookup();this.lookupWasPlaying=resume;this.video.pause();
    this.video.dispatchEvent(new Event('peekturn-lookup'));
    const generation=this.lookupGeneration;
    for(const root of [this.root,this.panelRoot])root.querySelectorAll(`.word[data-cue="${index}"][data-offset="${offset}"]`).forEach(n=>n.classList.add('selected'));
    const popup=element('section','explanation');popup.setAttribute('role','dialog');popup.setAttribute('aria-label',`Explain ${word}`);
    const head=element('header','explanation-header');const term=element('h2','',word);
    const speak=this.speechButton(word,'Pronounce word');
    const close=iconButton('close','Close explanation',()=>{this.closeLookup();trigger.isConnected?trigger.focus():this.showPanel.focus();});
    head.append(term,speak,close);const body=element('div','explanation-body');body.append(element('p','loading','Explaining in context…'));
    const foot=element('footer','explanation-footer');
    foot.append(iconButton('replay','Replay sentence',()=>{this.closeLookup();this.video.currentTime=cue.startMs/1000;void this.video.play().catch(()=>{});}));
    if(resume){const play=iconButton('play','Resume playback',()=>{this.closeLookup();void this.video.play().catch(()=>{});});play.classList.add('primary');foot.append(play);}
    else foot.append(iconButton('close','Close explanation',()=>this.closeLookup()));
    const speechStatus=element('div','speech-status');speechStatus.setAttribute('role','status');
    popup.append(head,body,speechStatus,foot);this.popup=popup;this.root.append(popup);close.focus({preventScroll:true});
    this.positionLookup();
    if(settings.autoPronounce)void this.pronounce(word);
    const allBefore=cue.text.slice(0,offset),allAfter=cue.text.slice(offset+word.length);
    const answer=await send({type:'explain',context:{selection:word,before:allBefore,after:allAfter,sourceTitle:document.querySelector('h1.ytd-watch-metadata')?.textContent?.trim()||document.title,sectionTitle:timestamp(cue.startMs)}});
    if(!this.alive||generation!==this.lookupGeneration)return;
    body.replaceChildren();
    if(!answer?.ok){body.append(element('p','error',answer?.error||'Could not explain this word.'),button('Open settings',()=>send({type:'options:open'})),button('Try again',()=>this.lookup(word,cue,index,offset,trigger)));return;}
    const a=answer.answer;term.textContent=a.term||word;
    const phonetic=element('p','phonetic',[settings.accent==='UK'?a.ukIpa:a.usIpa,a.partOfSpeech].filter(Boolean).join(' · '));
    const meaning=element('p','meaning',a.meaning);meaning.lang=settings.language==='zh'?'zh-CN':'en';
    const chinese=settings.language==='zh';
    body.append(phonetic,meaning,element('h3','section-label',chinese?'语境':'Context'),element('p','context',a.context));
    const examples=element('section','examples');examples.append(element('h3','section-label',chinese?'例句':'Examples'));
    for(const example of a.examples||[]){
      const row=element('div','example'),text=element('div','example-text');text.append(element('p','',example.text));
      if(example.translation){const translation=element('p','translation',example.translation);translation.lang='zh-CN';text.append(translation);}
      row.append(text,this.speechButton(example.text,'Pronounce example'));examples.append(row);
    }
    body.append(examples);
    if(a.synonyms||a.antonyms){const relations=element('div','relations');if(a.synonyms)relations.append(element('p','',`${chinese?'近义词':'Synonyms'}: ${a.synonyms}`));if(a.antonyms)relations.append(element('p','',`${chinese?'反义词':'Antonyms'}: ${a.antonyms}`));body.append(relations);}
  }
  speechButton(text,label){
    const control=iconButton('speaker',label,()=>this.pronounce(text));control.classList.add('speech-button');
    control.dataset.speech=text;control.dataset.label=label;control.setAttribute('aria-pressed','false');return control;
  }
  updateSpeechControls(){
    this.popup?.querySelectorAll('.speech-button').forEach(control=>{
      const active=control.dataset.speech===this.speakingText;
      control.replaceChildren(icon(active?'stop':'speaker'));
      control.setAttribute('aria-pressed',String(active));
      control.setAttribute('aria-label',active?'Stop pronunciation':control.dataset.label);
      control.title=active?'Stop pronunciation':control.dataset.label;
    });
  }
  async pronounce(text) {
    const popup=this.popup,generation=(this.speechGeneration||0)+1;this.speechGeneration=generation;
    if(this.speakingText===text){this.speakingText=null;this.updateSpeechControls();await send({type:'speech:stop'});return;}
    this.speakingText=text;this.updateSpeechControls();
    const result=await send({type:'speak',text,accent:settings.accent});
    if(generation!==this.speechGeneration)return;
    this.speakingText=null;this.updateSpeechControls();
    if(popup&&popup===this.popup)popup.querySelector('.speech-status').textContent=result?.ok?'':result?.error||'Pronunciation is unavailable.';
  }
  dispose() {
    this.alive=false;this.abort.abort();this.resize.disconnect();clearTimeout(this.captionTimeout);clearTimeout(this.copyReset);this.closeLookup();this.overlay.remove();this.panelHost.remove();this.nativeStyle?.remove();
  }
}
function mount() {
  const videoId=location.pathname==='/watch'?new URLSearchParams(location.search).get('v'):null;
  if(session&&(session.videoId!==videoId||!session.player.isConnected||!session.video.isConnected)){session.dispose();session=null;}
  if(!videoId||session)return;
  const player=document.querySelector('#movie_player');const video=player?.querySelector('video');
  const sidebar=document.querySelector('#secondary-inner')||document.querySelector('#secondary');
  if(player&&video&&sidebar)session=new WatchSession(videoId,player,video,sidebar);
}
chrome.runtime.onMessage.addListener(message=>{
  if(message?.type!=='settings:changed'||!message.settings)return;
  const previous=settings;settings=message.settings;
  if(session){
    const providerChanged=previous.endpoint!==settings.endpoint||previous.model!==settings.model;
    if(providerChanged){session.mergeGeneration=(session.mergeGeneration||0)+1;session.merging=false;session.merged=null;}
    session.mergeError=null;session.selectCues();
  }
});
document.addEventListener('yt-navigate-finish',mount);
setInterval(mount,1000);mount();
