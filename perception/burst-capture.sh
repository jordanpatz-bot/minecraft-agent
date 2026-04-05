#!/bin/bash
# Run capture in short bursts, restart on crash
# Each burst captures ~40-100 frames before puppeteer dies
# This script just keeps restarting until we hit the target

TARGET=${1:-2000}
OUTDIR="data/all_captures"
mkdir -p "$OUTDIR"

current() { ls "$OUTDIR"/frame_*.jpg 2>/dev/null | wc -l | tr -d ' '; }

echo "=== BURST CAPTURE — target: $TARGET frames ==="
echo "Output: $OUTDIR"

while [ "$(current)" -lt "$TARGET" ]; do
    START=$(current)
    echo "[BURST] Starting at frame $START..."
    
    # Kill any leftover processes
    lsof -ti:3000 2>/dev/null | xargs kill -9 2>/dev/null
    sleep 1
    
    # Run one burst
    timeout 300 node -e "
    const fs=require('fs'),path=require('path'),mineflayer=require('mineflayer');
    const {Rcon}=require('rcon-client');
    const sleep=ms=>new Promise(r=>setTimeout(r,ms));
    const OUT='$OUTDIR';
    
    function isH(n){return['zombie','skeleton','creeper','spider','slime','enderman','witch','phantom','drowned','husk','stray'].includes(n?.toLowerCase())}
    
    async function main(){
        const bot=mineflayer.createBot({host:'localhost',port:25565,username:'Burst'});
        await new Promise(r=>bot.once('spawn',r));
        const rcon=await Rcon.connect({host:'localhost',port:25575,password:'botadmin'});
        await rcon.send('gamemode creative Burst');
        await sleep(500);
        
        // Random location
        const rx=Math.floor(Math.random()*8000-4000);
        const rz=Math.floor(Math.random()*8000-4000);
        await rcon.send('spreadplayers '+rx+' '+rz+' 0 500 false Burst');
        await sleep(2000);
        for(let j=0;j<15;j++){await sleep(300);if(bot.entity.onGround)break;}
        
        // Random time of day
        const times=['0','6000','12000','18000'];
        await rcon.send('time set '+times[Math.floor(Math.random()*4)]);
        await sleep(300);
        
        bot.creative.startFlying();
        
        const{mineflayer:viewer}=require('prismarine-viewer');
        viewer(bot,{port:3000,firstPerson:true});
        const puppeteer=require('puppeteer');
        const browser=await puppeteer.launch({headless:true,args:['--no-sandbox'],defaultViewport:{width:1280,height:720}});
        const page=await browser.newPage();
        await page.goto('http://localhost:3000',{waitUntil:'networkidle2',timeout:15000});
        await sleep(3000);
        
        const existing=fs.readdirSync(OUT).filter(f=>f.match(/frame_\\\\d+\\\\.jpg/));
        let idx=existing.length>0?Math.max(...existing.map(f=>parseInt(f.match(/\\\\d+/)[0])))+1:0;
        let captured=0;
        
        for(let i=0;i<100;i++){
            const pos=bot.entity.position;
            
            // Look at nearest entity if available
            const nearEnt=Object.values(bot.entities)
                .filter(e=>e!==bot.entity&&e.position&&e.position.distanceTo(pos)<25)
                .sort((a,b)=>a.position.distanceTo(pos)-b.position.distanceTo(pos))[0];
            if(nearEnt&&Math.random()<0.6){
                await bot.lookAt(nearEnt.position.offset(0,1,0));
            }else{
                await bot.look((i*0.41)%(Math.PI*2),[0.25,0.1,0,0.3,-0.05,0.2][i%6]);
            }
            await sleep(200);
            
            const si=String(idx).padStart(5,'0');
            try{
                await page.screenshot({path:path.join(OUT,'frame_'+si+'.jpg'),type:'jpeg',quality:80});
                const entities=Object.values(bot.entities)
                    .filter(e=>e!==bot.entity&&e.position&&e.position.distanceTo(pos)<48)
                    .map(e=>({name:e.displayName||e.name,x:+e.position.x.toFixed(1),y:+e.position.y.toFixed(1),z:+e.position.z.toFixed(1),distance:+e.position.distanceTo(pos).toFixed(1),hostile:isH(e.name)}));
                const bt=new Set();
                for(let dx=-5;dx<=5;dx++)for(let dz=-5;dz<=5;dz++)for(let dy=-2;dy<=2;dy++){
                    const b=bot.blockAt(pos.offset(dx,dy,dz));if(b&&b.name!=='air')bt.add(b.name);
                }
                fs.writeFileSync(path.join(OUT,'state_'+si+'.json'),JSON.stringify({
                    timestamp:Date.now(),hasFrame:true,
                    player:{x:+pos.x.toFixed(1),y:+pos.y.toFixed(1),z:+pos.z.toFixed(1),yaw:+bot.entity.yaw.toFixed(2),pitch:+bot.entity.pitch.toFixed(2)},
                    world:{time:bot.time.timeOfDay,isDay:bot.time.timeOfDay<13000,biome:bot.blockAt(pos)?.biome?.name||'unknown'},
                    entities,blockTypes:[...bt],
                }));
                idx++;captured++;
            }catch{break;}
            
            // Fly + turn
            bot.setControlState('forward',true);bot.setControlState('sprint',true);
            await sleep(600);bot.setControlState('forward',false);bot.setControlState('sprint',false);
            
            // Relocate every 30 frames within burst
            if(i>0&&i%30===0){
                const nx=rx+Math.floor(Math.random()*1000-500);
                const nz=rz+Math.floor(Math.random()*1000-500);
                await rcon.send('spreadplayers '+nx+' '+nz+' 0 300 false Burst');
                await sleep(2000);
                try{await page.reload({waitUntil:'networkidle2',timeout:8000});}catch{break;}
                await sleep(1000);
            }
        }
        console.log('Burst captured '+captured+' frames (total: '+idx+')');
        await rcon.end();await browser.close();process.exit(0);
    }
    main().catch(e=>{process.exit(1)});
    " 2>&1
    
    END=$(current)
    GAINED=$((END - START))
    echo "[BURST] Got $GAINED frames (total: $END/$TARGET)"
    
    if [ "$GAINED" -eq 0 ]; then
        echo "[BURST] Zero frames — sleeping 5s before retry"
        sleep 5
    fi
    
    sleep 2
done

echo "=== TARGET REACHED: $(current) frames ==="
