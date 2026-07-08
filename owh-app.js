/* Operation Whole Health — Readiness Hub · learning layer (dual-mode)
   LOCAL MODE (default): profile + progress + followed studies live in this browser only.
   REAL MODE (once owh-config.js has a Supabase URL + anon key): real accounts, real
   cross-device sync, backed by Postgres with row-level security (see supabase-schema.sql).
   No PHI / health data is ever stored here — only course/quiz progress and followed
   public ClinicalTrials.gov listings. */
(function(){
  "use strict";
  var LS; try{ LS = window.localStorage; }catch(e){ LS = null; }
  var PKEY="owh_profile_v1", GKEY="owh_progress_v1";
  function read(k,def){ try{ return JSON.parse(LS.getItem(k)) || def; }catch(e){ return def; } }
  function write(k,v){ try{ LS.setItem(k, JSON.stringify(v)); }catch(e){} }
  function now(){ try{ return Date.now(); }catch(e){ return +new Date(); } }
  function esc(s){ return String(s==null?"":s).replace(/[&<>"]/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c];}); }
  function pad(n){ return n<10?"0"+n:""+n; }
  function ago(ts){ var d=Math.max(0,(now()-ts)/1000); if(d<60)return "just now"; if(d<3600)return Math.floor(d/60)+"m ago"; if(d<86400)return Math.floor(d/3600)+"h ago"; return Math.floor(d/86400)+"d ago"; }

  var COURSES = { patient:{name:"Patient Track", total:12, file:function(i){return "course-patient-"+pad(i)+".html";}, cert:"certificate-patient.html", index:"course-patient.html"}, caregiver:{name:"Caregiver Track", total:8, file:function(i){return "course-caregiver-"+pad(i)+".html";}, cert:"certificate-caregiver.html", index:"course-caregiver.html"}, provider:{name:"Provider Track", total:8, file:function(i){return "course-provider-"+pad(i)+".html";}, cert:"certificate-provider.html", index:"course-provider.html"} };

  // ---- mode detection --------------------------------------------------
  var CFG = window.OWH_CONFIG || {};
  var REAL_MODE = !!(CFG.supabaseUrl && CFG.supabaseAnonKey);
  var sb = null, currentUser = null;

  // ---- shared in-memory state (both modes render from this) ------------
  var profile = null;
  var state = {modules:{}, followed:[], activity:[]};

  function hydrateFromLocal(){
    profile = read(PKEY, null);
    state = read(GKEY, {modules:{}, followed:[], activity:[]});
    state.modules = state.modules || {}; state.followed = state.followed || []; state.activity = state.activity || [];
  }
  function persistLocal(){ write(GKEY, state); }

  function loadSupabaseJs(){
    return new Promise(function(resolve, reject){
      if(window.supabase && window.supabase.createClient){ resolve(); return; }
      var s = document.createElement("script");
      s.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
      s.onload = function(){ resolve(); };
      s.onerror = function(){ reject(new Error("Failed to load the Supabase client library")); };
      document.head.appendChild(s);
    });
  }

  function hydrateFromSupabase(user){
    currentUser = user;
    return Promise.all([
      sb.from("profiles").select("*").eq("id", user.id).maybeSingle(),
      sb.from("module_progress").select("*").eq("user_id", user.id),
      sb.from("followed_studies").select("*").eq("user_id", user.id).order("created_at",{ascending:false}),
      sb.from("activity_log").select("*").eq("user_id", user.id).order("created_at",{ascending:false}).limit(80)
    ]).then(function(results){
      var profRes=results[0], modRes=results[1], folRes=results[2], actRes=results[3];
      profile = (profRes && profRes.data) ? { id:profRes.data.id, name:profRes.data.name, email:profRes.data.email, created:profRes.data.created_at } : null;
      var modules = {};
      ((modRes && modRes.data) || []).forEach(function(r){
        modules[r.course] = modules[r.course] || {};
        modules[r.course][r.module_id] = { passed:r.passed, best:r.best_score, lastScore:r.last_score, attempts:r.attempts, ts:new Date(r.updated_at).getTime() };
      });
      state = {
        modules: modules,
        followed: ((folRes && folRes.data) || []).map(function(r){ return {id:r.nct_id, title:r.title, url:r.url, cond:r.condition_label||"", ts:new Date(r.created_at).getTime()}; }),
        activity: ((actRes && actRes.data) || []).map(function(r){ return {type:r.type, label:r.label, ts:new Date(r.created_at).getTime()}; })
      };
    });
  }

  var readyResolve, readyReject;
  var ready = new Promise(function(res,rej){ readyResolve=res; readyReject=rej; });

  if(REAL_MODE){
    loadSupabaseJs().then(function(){
      sb = window.supabase.createClient(CFG.supabaseUrl, CFG.supabaseAnonKey, { auth: { detectSessionInUrl:true, persistSession:true, autoRefreshToken:true } });
      sb.auth.onAuthStateChange(function(event, session){
        if(event==="SIGNED_IN" && session && session.user){
          hydrateFromSupabase(session.user).then(function(){ if(typeof window.OWH_ON_AUTH_CHANGE==="function") window.OWH_ON_AUTH_CHANGE("SIGNED_IN"); });
        } else if(event==="SIGNED_OUT"){
          currentUser=null; profile=null; state={modules:{},followed:[],activity:[]};
          if(typeof window.OWH_ON_AUTH_CHANGE==="function") window.OWH_ON_AUTH_CHANGE("SIGNED_OUT");
        }
      });
      return sb.auth.getSession();
    }).then(function(res){
      var session = res && res.data && res.data.session;
      if(session && session.user){ return hydrateFromSupabase(session.user); }
    }).then(function(){ readyResolve(); }).catch(function(e){
      console.error("OWH: Supabase unavailable, falling back to local-only mode.", e);
      REAL_MODE = false; hydrateFromLocal(); readyResolve();
    });
  } else {
    hydrateFromLocal(); readyResolve();
  }

  var OWH = {
    COURSES: COURSES,
    ready: ready,
    isRealMode: function(){ return REAL_MODE; },

    // ---- auth (real mode) ------------------------------------------------
    sendMagicLink: function(email){
      if(!REAL_MODE || !sb) return Promise.resolve({error:{message:"Real accounts are not configured yet."}});
      return sb.auth.signInWithOtp({ email: email, options: { emailRedirectTo: location.origin + location.pathname } });
    },
    getSession: function(){ return currentUser; },

    // ---- profile -----------------------------------------------------
    getProfile:function(){ return profile; },
    setProfile:function(p){
      if(REAL_MODE && sb){
        if(!currentUser) return Promise.reject(new Error("Not signed in yet."));
        var row = { id:currentUser.id, name:p.name, email:p.email||currentUser.email||null };
        return sb.from("profiles").upsert(row).select().maybeSingle().then(function(res){
          var d = (res && res.data) || row;
          profile = { id:d.id, name:d.name, email:d.email, created:d.created_at||now() };
          OWH.logActivity("account","Signed in as "+profile.name);
          return profile;
        });
      }
      p.created = p.created || now(); write(PKEY,p); profile = p;
      this.logActivity("account","Signed in as "+p.name);
      return p;
    },
    logout:function(){
      if(REAL_MODE && sb){ sb.auth.signOut().catch(function(){}); }
      else if(LS) LS.removeItem(PKEY);
      profile = null; state = {modules:{}, followed:[], activity:[]};
    },

    // ---- quiz progress -----------------------------------------------
    // rawAnswers (optional): the user's selected option index per question, in order.
    // When present in REAL_MODE, the score is independently recomputed server-side via
    // submit_module_result() against a private answer key — the client's own pct/passed
    // are used only for instant on-screen feedback, never trusted for what gets saved.
    recordQuiz:function(course,moduleId,scorePct,passed,rawAnswers){
      var self=this;
      state.modules[course] = state.modules[course] || {};
      var prev = state.modules[course][moduleId] || {attempts:0,best:0,passed:false};
      var rec = { passed:(prev.passed||false)||!!passed, best:Math.max(scorePct,prev.best||0), lastScore:scorePct, attempts:(prev.attempts||0)+1, ts:now() };
      state.modules[course][moduleId] = rec; // optimistic, for instant UI

      if(REAL_MODE && sb && currentUser && rawAnswers){
        sb.rpc("submit_module_result", { p_course:course, p_module_id:moduleId, p_answers:rawAnswers }).then(function(res){
          if(res && res.error){ console.error("OWH: server grading failed, keeping optimistic local result", res.error); return; }
          var row = res && res.data && res.data[0];
          if(row){
            var serverRec = { passed:(prev.passed||false)||!!row.passed, best:Math.max(row.score,prev.best||0), lastScore:row.score, attempts:(prev.attempts||0)+1, ts:now() };
            state.modules[course][moduleId] = serverRec;
          }
        }, function(e){ console.error("OWH: failed to reach grading function, keeping optimistic local result", e); });
      } else if(REAL_MODE && sb && currentUser){
        // no rawAnswers supplied (shouldn't normally happen from mountQuiz) — nothing to grade server-side safely
        console.warn("OWH: recordQuiz called in real mode without rawAnswers; result kept local-only for this session.");
      } else { persistLocal(); }

      this.logActivity("quiz",(passed?"Passed ":"Tried ")+(COURSES[course]?COURSES[course].name:course)+" · Module "+moduleId+" ("+scorePct+"%)");
      return rec;
    },
    moduleState:function(course,moduleId){ return (state.modules[course]||{})[moduleId]||null; },
    isPassed:function(course,moduleId){ var s=this.moduleState(course,moduleId); return !!(s&&s.passed); },
    courseProgress:function(course){
      var total=(COURSES[course]||{}).total||0, m=state.modules[course]||{}, passed=0;
      for(var k in m){ if(m[k]&&m[k].passed) passed++; }
      return {passed:passed,total:total,pct: total?Math.round(passed/total*100):0, complete: total>0&&passed>=total};
    },
    nextModule:function(course){ var total=(COURSES[course]||{}).total||0; for(var i=1;i<=total;i++){ if(!this.isPassed(course,pad(i))) return i; } return null; },

    // ---- followed studies ----------------------------------------------
    followStudy:function(s){
      if(!state.followed.some(function(x){return x.id===s.id;})){
        state.followed.unshift({id:s.id,title:s.title,url:s.url,cond:s.cond||"",ts:now()});
        if(REAL_MODE && sb && currentUser){
          sb.from("followed_studies").insert({ user_id:currentUser.id, nct_id:s.id, title:s.title, url:s.url, condition_label:s.cond||"" }).then(function(){}, function(e){ console.error("OWH: failed to sync followed study", e); });
        } else { persistLocal(); }
        this.logActivity("follow","Followed a study · "+s.id);
      }
      return state.followed;
    },
    unfollowStudy:function(id){
      state.followed = state.followed.filter(function(x){return x.id!==id;});
      if(REAL_MODE && sb && currentUser){
        sb.from("followed_studies").delete().eq("user_id",currentUser.id).eq("nct_id",id).then(function(){}, function(e){ console.error("OWH: failed to unfollow study", e); });
      } else { persistLocal(); }
      return state.followed;
    },
    toggleFollow:function(s){ if(this.isFollowing(s.id)){ this.unfollowStudy(s.id); return false; } this.followStudy(s); return true; },
    isFollowing:function(id){ return state.followed.some(function(x){return x.id===id;}); },
    getFollowed:function(){ return state.followed; },

    // ---- activity feed ---------------------------------------------------
    logActivity:function(type,label){
      state.activity.unshift({type:type,label:label,ts:now()});
      if(state.activity.length>80) state.activity = state.activity.slice(0,80);
      if(REAL_MODE && sb && currentUser){
        sb.from("activity_log").insert({ user_id:currentUser.id, type:type, label:label }).then(function(){}, function(e){ console.error("OWH: failed to log activity", e); });
      } else { persistLocal(); }
    },
    getActivity:function(){ return state.activity; },

    resetProgress:function(){
      state = {modules:{}, followed:[], activity:[]};
      if(REAL_MODE && sb && currentUser){
        var uid = currentUser.id;
        return Promise.all([
          sb.from("module_progress").delete().eq("user_id",uid),
          sb.from("followed_studies").delete().eq("user_id",uid),
          sb.from("activity_log").delete().eq("user_id",uid)
        ]).catch(function(e){ console.error("OWH: failed to reset remote progress", e); });
      }
      if(LS) LS.removeItem(GKEY);
      return Promise.resolve();
    },

    requireLogin:function(){ if(!this.getProfile()){ var f=location.pathname.split("/").pop()||"dashboard.html"; location.href="login.html?next="+encodeURIComponent(f); return false; } return true; },
    fmtTime:ago,
    accountChip:function(){ var p=this.getProfile(); if(p){ var f=(p.name||"You").split(" ")[0]; return '<a class="owh-chip" href="dashboard.html" title="Your dashboard">'+esc(f)+"'s dashboard</a>"; } return '<a class="owh-chip guest" href="login.html">Log in</a>'; },
    mountChip:function(){ var el=document.getElementById("owh-chip"); if(el) el.innerHTML=this.accountChip(); },

    /* quiz engine: OWH.mountQuiz("elId",{course,moduleId,passPct,questions:[{q,options:[],answer,explain}]}) */
    mountQuiz:function(elId,opts){
      var host=document.getElementById(elId); if(!host) return;
      var self=this, pass=opts.passPct||75, qs=opts.questions||[];
      var already=this.moduleState(opts.course,opts.moduleId);
      function nextHref(){ var c=COURSES[opts.course]; var n=parseInt(opts.moduleId,10)+1; return (n>c.total)? c.cert : c.file(n); }
      function nextLabel(){ var c=COURSES[opts.course]; var n=parseInt(opts.moduleId,10)+1; return (n>c.total)? "Get your certificate →" : "Next module "+pad(n)+" →"; }
      function draw(showPassedBanner){
        var h='';
        h+='<div class="owh-quiz">';
        h+='<div class="owh-qhd"><span class="owh-qkick">Check &amp; pass</span><h3>Module quiz — pass to complete this module</h3><p class="owh-qsub">'+qs.length+' questions · '+pass+'% to pass · retake as many times as you need.</p></div>';
        if(showPassedBanner || (already&&already.passed)){
          h+='<div class="owh-pass">✓ <b>You passed this module.</b> '+(already?'Best score '+already.best+'%.':'')+' It’s marked complete on your <a href="dashboard.html">dashboard</a>. <a class="owh-next" href="'+nextHref()+'">'+nextLabel()+'</a></div>';
        }
        h+='<form class="owh-qform">';
        qs.forEach(function(q,i){
          h+='<div class="owh-q" data-i="'+i+'"><p class="owh-qq"><b>'+(i+1)+'.</b> '+q.q+'</p>';
          q.options.forEach(function(o,j){ h+='<label class="owh-opt"><input type="radio" name="q'+i+'" value="'+j+'"> <span>'+o+'</span></label>'; });
          h+='<div class="owh-exp" style="display:none"></div></div>';
        });
        h+='<div class="owh-actions"><button type="submit" class="owh-btn">Submit answers</button><span class="owh-score"></span></div>';
        h+='</form></div>';
        host.innerHTML=h;
        var form=host.querySelector(".owh-qform");
        form.addEventListener("submit",function(e){ e.preventDefault(); grade(form); });
      }
      function grade(form){
        var correct=0, answered=0, rawAnswers=[];
        qs.forEach(function(q,i){
          var box=form.querySelector('.owh-q[data-i="'+i+'"]');
          var sel=form.querySelector('input[name="q'+i+'"]:checked');
          var exp=box.querySelector(".owh-exp");
          box.classList.remove("ok","no");
          var val = sel ? parseInt(sel.value,10) : -1;
          rawAnswers.push(val);
          if(sel){ answered++;
            if(val===q.answer){ correct++; box.classList.add("ok"); } else { box.classList.add("no"); }
          } else { box.classList.add("no"); }
          exp.style.display="block";
          exp.innerHTML='<b>'+(sel&&val===q.answer?"Correct.":"Answer: "+q.options[q.answer]+".")+'</b> '+(q.explain||"");
        });
        var pct=Math.round(correct/qs.length*100);
        var passed=pct>=pass;
        self.recordQuiz(opts.course,opts.moduleId,pct,passed,rawAnswers);
        var scoreEl=form.querySelector(".owh-score");
        scoreEl.innerHTML=(passed?'<span class="owh-ok">':'<span class="owh-no">')+'You scored '+pct+'% ('+correct+'/'+qs.length+') — '+(passed?'PASSED':'not yet, keep going')+'</span>';
        already=self.moduleState(opts.course,opts.moduleId);
        if(passed){ draw(true); host.querySelector(".owh-quiz").scrollIntoView({behavior:"smooth",block:"start"}); }
        else {
          var act=form.querySelector(".owh-actions");
          if(!act.querySelector(".owh-retry")){ var b=document.createElement("button"); b.type="button"; b.className="owh-btn owh-retry"; b.textContent="Try again"; b.onclick=function(){ draw(false); }; act.appendChild(b); }
        }
      }
      draw(false);
    }
  };

  // inject shared styles (chip + quiz) so pages don't each need CSS
  function injectCSS(){
    if(document.getElementById("owh-app-css")) return;
    var css=''
     +'.owh-chip{display:inline-block;background:#c1873d;color:#241606;font-weight:700;font-size:12.5px;padding:7px 13px;border-radius:20px;margin-left:14px;text-decoration:none;font-family:system-ui,Arial,sans-serif}'
     +'.owh-chip:hover{background:#d9b877;color:#241606}.owh-chip.guest{background:#16314f;color:#fff}'
     +'.owh-quiz{background:#f6f8fb;border:1px solid #cfe0ef;border-radius:12px;padding:18px 20px;margin:8px 0;font-family:system-ui,-apple-system,Arial,sans-serif}'
     +'.owh-qkick{font-size:10.5px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#c1873d}'
     +'.owh-qhd h3{font-family:Georgia,serif;color:#16314f;font-size:18px;margin:2px 0 2px}.owh-qsub{margin:0 0 6px;font-size:12.5px;color:#5c6b7a}'
     +'.owh-q{padding:12px 0;border-top:1px solid #e6e2d6}.owh-qq{margin:0 0 8px;color:#1b2733;font-size:14.5px}'
     +'.owh-opt{display:flex;gap:9px;align-items:flex-start;padding:7px 10px;border:1px solid #e6e2d6;border-radius:8px;margin:5px 0;background:#fff;cursor:pointer;font-size:14px;color:#1b2733}'
     +'.owh-opt:hover{border-color:#e9d6b0}.owh-opt input{margin-top:3px}'
     +'.owh-q.ok .owh-opt{border-color:#cfe6d8}.owh-q.no .owh-opt{border-color:#efc9c2}'
     +'.owh-exp{margin-top:7px;font-size:13px;color:#33424f;background:#fff;border-left:3px solid #c1873d;border-radius:6px;padding:8px 11px}'
     +'.owh-actions{margin-top:14px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}'
     +'.owh-btn{background:#16314f;color:#fff;border:none;border-radius:8px;padding:10px 18px;font-weight:700;font-size:13.5px;cursor:pointer}'
     +'.owh-btn:hover{background:#1f4368}.owh-btn.owh-retry{background:#c1873d;color:#241606}'
     +'.owh-score{font-size:13.5px;font-weight:700}.owh-ok{color:#2e7d52}.owh-no{color:#9e2a2b}'
     +'.owh-pass{background:#eef6f0;border:1px solid #cfe6d8;border-left:4px solid #2e7d52;border-radius:9px;padding:12px 15px;margin:10px 0;font-size:14px;color:#1b3a29}'
     +'.owh-pass .owh-next{display:inline-block;margin-left:8px;background:#c1873d;color:#241606;font-weight:700;padding:6px 13px;border-radius:8px;text-decoration:none}'
     +'.owh-follow{display:inline-flex;align-items:center;gap:6px;background:#fff;border:1px solid #cfe0ef;color:#1f4368;font-weight:700;font-size:12px;padding:5px 11px;border-radius:20px;cursor:pointer;font-family:system-ui,Arial,sans-serif}'
     +'.owh-follow.on{background:#16314f;color:#fff;border-color:#16314f}'
     +'.owh-mlink{max-width:420px}.owh-mlink input[type=email]{width:100%;border:1px solid #e6e2d6;border-radius:10px;padding:12px 14px;font-size:15px;background:#fcfbf7;box-sizing:border-box}'
     +'.owh-mlink .sent{background:#eef6f0;border:1px solid #cfe6d8;border-radius:10px;padding:14px 16px;font-size:14px;color:#1b3a29}';
    var s=document.createElement("style"); s.id="owh-app-css"; s.textContent=css; document.head.appendChild(s);
  }
  function boot(){ injectCSS(); ready.then(function(){ OWH.mountChip(); }); }
  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded",boot); else boot();
  window.OWH=OWH;
})();
