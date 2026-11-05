const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA = path.join(__dirname, 'data');
const UPLOADS = path.join(DATA, 'uploads');
const OUTPUTS = path.join(DATA, 'outputs');
for (const dir of [UPLOADS, OUTPUTS]) fs.mkdirSync(dir, { recursive: true });
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));
const jobs = new Map();
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOADS),
  filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}${path.extname(file.originalname).toLowerCase()}`)
});
const upload = multer({
  storage,
  limits: { fileSize: 1024 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => ['.mp4','.mov','.mkv','.webm','.m4v'].includes(path.extname(file.originalname).toLowerCase())
    ? cb(null, true) : cb(new Error('目前支持 MP4、MOV、MKV、WebM 和 M4V 视频文件。'))
});
function run(command, args, timeoutMs = 20 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore','pipe','pipe'] });
    let stdout = ''; let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve({ stdout, stderr }) : reject(new Error(`${command} 执行失败（${code}）：${stderr.slice(-1000)}`)); });
  });
}
const round = n => Math.round(n * 10) / 10;
function fallback(duration) {
  const count = Math.max(1, Math.min(8, Math.ceil(duration / 600)));
  return Array.from({length: count}, (_, i) => {
    const start = Math.max(0, Math.min(duration - 0.1, i * duration / count));
    return { id:`候选${i+1}`, start:round(start), end:round(Math.min(duration, start + Math.min(40, Math.max(10, duration/count)))), title:`待人工检查片段 ${i+1}`, category:'待人工检查', score:0, summary:'未能可靠筛选音频活动，请播放原片并确认是否有值得保留的亮点。' };
  });
}
async function analyze(job) {
  job.status = 'analyzing'; job.progress = 8;
  const p = await run('ffprobe',['-v','error','-show_entries','format=duration:stream=codec_type,width,height,r_frame_rate','-of','json',job.inputPath]);
  const meta = JSON.parse(p.stdout); const duration = Number(meta.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) throw new Error('无法读取视频时长，请确认文件有效。');
  job.duration = duration; job.streams = meta.streams || []; job.hasAudio = job.streams.some(s => s.codec_type === 'audio'); job.progress = 25;
  if (!job.hasAudio) { job.highlights = fallback(duration); job.notice = '视频没有音轨，已建立待审核片段，无法进行音频活动粗筛。'; job.status='review_required'; job.progress=100; return; }
  const pcmPath = path.join(OUTPUTS, `${job.id}-analysis.pcm`);
  await run('ffmpeg',['-y','-i',job.inputPath,'-vn','-ac','1','-ar','8000','-f','s16le',pcmPath]); job.progress = 70;
  const pcm=fs.readFileSync(pcmPath); fs.unlinkSync(pcmPath); const bytesPerSecond=16000; const energy=[];
  for(let off=0;off+1<pcm.length;off+=bytesPerSecond){let sum=0,n=0;for(let i=off;i+1<Math.min(pcm.length,off+bytesPerSecond);i+=2){const x=pcm.readInt16LE(i)/32768;sum+=x*x;n++;}energy.push(n?Math.sqrt(sum/n):0);}
  const sorted=[...energy].sort((a,b)=>a-b); const threshold=Math.max(.018,sorted[Math.floor(sorted.length*.65)]||.018); const active=energy.map(x=>x>=threshold); const ranges=[];let begin=-1;
  for(let i=0;i<=active.length;i++){if(i<active.length&&active[i]){if(begin<0)begin=i;}else if(begin>=0){if(i-begin>=5)ranges.push({start:begin,end:i});begin=-1;}}
  const merged=[];for(const r of ranges){const prev=merged.at(-1);if(prev&&r.start-prev.end<=8)prev.end=r.end;else merged.push({...r});}
  const candidates=merged.map(r=>{const start=Math.max(0,r.start-3),end=Math.min(duration,Math.max(r.end+2,start+12));const mean=energy.slice(r.start,r.end).reduce((a,b)=>a+b,0)/Math.max(1,r.end-r.start);return{start,end,mean};}).filter(x=>x.end-x.start>=8&&x.end-x.start<=75).sort((a,b)=>b.mean-a.mean).slice(0,12).sort((a,b)=>a.start-b.start);
  job.highlights=candidates.length?candidates.map((c,i)=>({id:`候选${i+1}`,start:round(c.start),end:round(c.end),title:`待审核高光候选 ${i+1}`,category:'音频活动较明显',score:Math.min(.99,round(.5+c.mean*.45)),summary:'根据音频能量粗筛，尚未理解具体内容。请核对是否为教学示范、答疑、学员进步或互动亮点。'})):fallback(duration);
  job.notice='音频活动强度粗筛不是语义高光识别。请逐条播放审核；该分数不代表教学价值或传播效果。'; job.status='review_required'; job.progress=100;
}
function publicJob(j){return{id:j.id,filename:j.filename,status:j.status,progress:j.progress,duration:j.duration||null,hasAudio:j.hasAudio??null,notice:j.notice||null,error:j.error||null,highlights:j.highlights||[],renders:j.renders||[],createdAt:j.createdAt};}
app.get('/api/health',(_req,res)=>res.json({data:{status:'正常',message:'服务运行正常'},error:null}));
app.post('/api/jobs',upload.single('video'),(req,res)=>{
  if(!req.file)return res.status(400).json({error:{code:'VIDEO_REQUIRED',message:'请先选择视频文件。'}});
  const id=crypto.randomUUID();const job={id,filename:path.basename(req.file.originalname),inputPath:req.file.path,status:'queued',progress:0,createdAt:new Date().toISOString(),highlights:[]};jobs.set(id,job);
  analyze(job).catch(e=>{job.status='failed';job.error=e.message;});res.status(202).json({data:publicJob(job),error:null});
});
app.get('/api/jobs/:id',(req,res)=>{const j=jobs.get(req.params.id);if(!j)return res.status(404).json({error:{code:'JOB_NOT_FOUND',message:'找不到这个任务。'}});res.json({data:publicJob(j),error:null});});
app.get('/api/jobs/:id/source',(req,res)=>{const j=jobs.get(req.params.id);if(!j||!fs.existsSync(j.inputPath))return res.status(404).json({error:{code:'SOURCE_NOT_FOUND',message:'找不到原始视频。'}});res.sendFile(j.inputPath);});
app.patch('/api/jobs/:id/highlights/:hid',(req,res)=>{const j=jobs.get(req.params.id),h=j?.highlights.find(x=>x.id===req.params.hid);if(!h)return res.status(404).json({error:{code:'HIGHLIGHT_NOT_FOUND',message:'找不到这个候选片段。'}});const start=Number(req.body.start),end=Number(req.body.end),title=String(req.body.title||'').trim().slice(0,100);if(!Number.isFinite(start)||!Number.isFinite(end)||start<0||end<=start||end>j.duration)return res.status(400).json({error:{code:'INVALID_RANGE',message:'起止时间无效，结束时间须大于开始时间且不能超过视频时长。'}});h.start=round(start);h.end=round(end);if(title)h.title=title;res.json({data:h,error:null});});
app.post('/api/jobs/:id/renders',async(req,res)=>{const j=jobs.get(req.params.id);if(!j)return res.status(404).json({error:{code:'JOB_NOT_FOUND',message:'找不到这个任务。'}});const ids=Array.isArray(req.body.highlight_ids)?req.body.highlight_ids:[];const selected=j.highlights.filter(h=>ids.includes(h.id));if(!selected.length)return res.status(400).json({error:{code:'NO_HIGHLIGHTS',message:'请至少选择一个片段。'}});const task={id:crypto.randomUUID(),status:'生成中',outputs:[],createdAt:new Date().toISOString()};j.renders=j.renders||[];j.renders.push(task);res.status(202).json({data:task,error:null});
  (async()=>{try{for(let i=0;i<selected.length;i++){const h=selected[i],filename=`${task.id}-${i+1}.mp4`,out=path.join(OUTPUTS,filename);await run('ffmpeg',['-y','-ss',String(h.start),'-i',j.inputPath,'-t',String(h.end-h.start),'-map','0:v:0','-map','0:a?','-c:v','libx264','-preset','veryfast','-crf','22','-c:a','aac','-movflags','+faststart',out]);task.outputs.push({filename,title:h.title,url:`/api/files/${encodeURIComponent(filename)}`});}task.status='已完成';}catch(e){task.status='失败';task.error=e.message;}})();
});
app.get('/api/jobs/:id/plan',(req,res)=>{const j=jobs.get(req.params.id);if(!j)return res.status(404).json({error:{code:'JOB_NOT_FOUND',message:'找不到这个任务。'}});res.json({data:{标题:'直播高光剪辑计划',语言:'简体中文',原视频:j.filename,时长秒:j.duration,片段:j.highlights.map(h=>({编号:h.id,开始秒:h.start,结束秒:h.end,标题:h.title,类别:h.category,摘要:h.summary})),包装建议:{画幅:'9:16',分辨率:'1080×1920',字幕:'待接入语音识别后生成',首尾海报一致:true,音乐:'仅使用已授权音乐',说明:'这是剪辑计划，不是 HyperFrames 工程或已渲染成片。'}},error:null});});
app.get('/api/files/:filename',(req,res)=>{const filename=path.basename(req.params.filename),file=path.join(OUTPUTS,filename);if(!fs.existsSync(file))return res.status(404).json({error:{code:'FILE_NOT_FOUND',message:'文件不存在或已清理。'}});res.download(file);});
app.use((err,_req,res,_next)=>res.status(400).json({error:{code:'REQUEST_FAILED',message:err.message||'请求失败。'}}));
app.listen(PORT,()=>console.log(`直播高光剪辑智能体已启动：http://localhost:${PORT}`));
