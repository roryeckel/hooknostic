const require = globalThis.process.getBuiltinModule("node:module").createRequire(import.meta.url);
var De=Object.create;var W=Object.defineProperty;var Fe=Object.getOwnPropertyDescriptor;var Me=Object.getOwnPropertyNames;var We=Object.getPrototypeOf,ze=Object.prototype.hasOwnProperty;var h=(e=>typeof require<"u"?require:typeof Proxy<"u"?new Proxy(e,{get:(n,t)=>(typeof require<"u"?require:n)[t]}):e)(function(e){if(typeof require<"u")return require.apply(this,arguments);throw Error('Dynamic require of "'+e+'" is not supported')});var f=(e,n)=>()=>(n||e((n={exports:{}}).exports,n),n.exports);var He=(e,n,t,r)=>{if(n&&typeof n=="object"||typeof n=="function")for(let s of Me(n))!ze.call(e,s)&&s!==t&&W(e,s,{get:()=>n[s],enumerable:!(r=Fe(n,s))||r.enumerable});return e};var z=(e,n,t)=>(t=e!=null?De(We(e)):{},He(n||!e||!e.__esModule?W(t,"default",{value:e,enumerable:!0}):t,e));var J=f((Un,X)=>{X.exports=B;B.sync=Be;var H=h("fs");function Ke(e,n){var t=n.pathExt!==void 0?n.pathExt:process.env.PATHEXT;if(!t||(t=t.split(";"),t.indexOf("")!==-1))return!0;for(var r=0;r<t.length;r++){var s=t[r].toLowerCase();if(s&&e.substr(-s.length).toLowerCase()===s)return!0}return!1}function K(e,n,t){return!e.isSymbolicLink()&&!e.isFile()?!1:Ke(n,t)}function B(e,n,t){H.stat(e,function(r,s){t(r,r?!1:K(s,e,n))})}function Be(e,n){return K(H.statSync(e),e,n)}});var ee=f((Dn,Q)=>{Q.exports=Y;Y.sync=Xe;var V=h("fs");function Y(e,n,t){V.stat(e,function(r,s){t(r,r?!1:Z(s,n))})}function Xe(e,n){return Z(V.statSync(e),n)}function Z(e,n){return e.isFile()&&Je(e,n)}function Je(e,n){var t=e.mode,r=e.uid,s=e.gid,o=n.uid!==void 0?n.uid:process.getuid&&process.getuid(),c=n.gid!==void 0?n.gid:process.getgid&&process.getgid(),i=parseInt("100",8),u=parseInt("010",8),a=parseInt("001",8),d=i|u,m=t&a||t&u&&s===c||t&i&&r===o||t&d&&o===0;return m}});var te=f((Mn,ne)=>{var Fn=h("fs"),P;process.platform==="win32"||global.TESTING_WINDOWS?P=J():P=ee();ne.exports=$;$.sync=Ve;function $(e,n,t){if(typeof n=="function"&&(t=n,n={}),!t){if(typeof Promise!="function")throw new TypeError("callback not provided");return new Promise(function(r,s){$(e,n||{},function(o,c){o?s(o):r(c)})})}P(e,n||{},function(r,s){r&&(r.code==="EACCES"||n&&n.ignoreErrors)&&(r=null,s=!1),t(r,s)})}function Ve(e,n){try{return P.sync(e,n||{})}catch(t){if(n&&n.ignoreErrors||t.code==="EACCES")return!1;throw t}}});var ue=f((Wn,ae)=>{var v=process.platform==="win32"||process.env.OSTYPE==="cygwin"||process.env.OSTYPE==="msys",re=h("path"),Ye=v?";":":",se=te(),oe=e=>Object.assign(new Error(`not found: ${e}`),{code:"ENOENT"}),ce=(e,n)=>{let t=n.colon||Ye,r=e.match(/\//)||v&&e.match(/\\/)?[""]:[...v?[process.cwd()]:[],...(n.path||process.env.PATH||"").split(t)],s=v?n.pathExt||process.env.PATHEXT||".EXE;.CMD;.BAT;.COM":"",o=v?s.split(t):[""];return v&&e.indexOf(".")!==-1&&o[0]!==""&&o.unshift(""),{pathEnv:r,pathExt:o,pathExtExe:s}},ie=(e,n,t)=>{typeof n=="function"&&(t=n,n={}),n||(n={});let{pathEnv:r,pathExt:s,pathExtExe:o}=ce(e,n),c=[],i=a=>new Promise((d,m)=>{if(a===r.length)return n.all&&c.length?d(c):m(oe(e));let p=r[a],S=/^".*"$/.test(p)?p.slice(1,-1):p,y=re.join(S,e),A=!S&&/^\.[\\\/]/.test(e)?e.slice(0,2)+y:y;d(u(A,a,0))}),u=(a,d,m)=>new Promise((p,S)=>{if(m===s.length)return p(i(d+1));let y=s[m];se(a+y,{pathExt:o},(A,Ue)=>{if(!A&&Ue)if(n.all)c.push(a+y);else return p(a+y);return p(u(a,d,m+1))})});return t?i(0).then(a=>t(null,a),t):i(0)},Ze=(e,n)=>{n=n||{};let{pathEnv:t,pathExt:r,pathExtExe:s}=ce(e,n),o=[];for(let c=0;c<t.length;c++){let i=t[c],u=/^".*"$/.test(i)?i.slice(1,-1):i,a=re.join(u,e),d=!u&&/^\.[\\\/]/.test(e)?e.slice(0,2)+a:a;for(let m=0;m<r.length;m++){let p=d+r[m];try{if(se.sync(p,{pathExt:s}))if(n.all)o.push(p);else return p}catch{}}}if(n.all&&o.length)return o;if(n.nothrow)return null;throw oe(e)};ae.exports=ie;ie.sync=Ze});var le=f((zn,q)=>{"use strict";var fe=(e={})=>{let n=e.env||process.env;return(e.platform||process.platform)!=="win32"?"PATH":Object.keys(n).reverse().find(r=>r.toUpperCase()==="PATH")||"Path"};q.exports=fe;q.exports.default=fe});var he=f((Hn,de)=>{"use strict";var me=h("path"),Qe=ue(),en=le();function pe(e,n){let t=e.options.env||process.env,r=process.cwd(),s=e.options.cwd!=null,o=s&&process.chdir!==void 0&&!process.chdir.disabled;if(o)try{process.chdir(e.options.cwd)}catch{}let c;try{c=Qe.sync(e.command,{path:t[en({env:t})],pathExt:n?me.delimiter:void 0})}catch{}finally{o&&process.chdir(r)}return c&&(c=me.resolve(s?e.options.cwd:"",c)),c}function nn(e){return pe(e)||pe(e,!0)}de.exports=nn});var _=f((Kn,I)=>{"use strict";var j=/([()\][%!^"`<>&|;, *?])/g;function tn(e){return e=e.replace(j,"^$1"),e}function rn(e,n){return e=`${e}`,e=e.replace(/(?=(\\+?)?)\1"/g,'$1$1\\"'),e=e.replace(/(?=(\\+?)?)\1$/,"$1$1"),e=`"${e}"`,e=e.replace(j,"^$1"),n&&(e=e.replace(j,"^$1")),e}I.exports.command=tn;I.exports.argument=rn});var ye=f((Bn,Ee)=>{"use strict";Ee.exports=/^#!(.*)/});var xe=f((Xn,ve)=>{"use strict";var sn=ye();ve.exports=(e="")=>{let n=e.match(sn);if(!n)return null;let[t,r]=n[0].replace(/#! ?/,"").split(" "),s=t.split("/").pop();return s==="env"?r:r?`${s} ${r}`:s}});var we=f((Jn,ge)=>{"use strict";var R=h("fs"),on=xe();function cn(e){let t=Buffer.alloc(150),r;try{r=R.openSync(e,"r"),R.readSync(r,t,0,150,0),R.closeSync(r)}catch{}return on(t.toString())}ge.exports=cn});var Te=f((Vn,Oe)=>{"use strict";var an=h("path"),Se=he(),Ne=_(),un=we(),fn=process.platform==="win32",ln=/\.(?:com|exe)$/i,mn=/node_modules[\\/].bin[\\/][^\\/]+\.cmd$/i;function pn(e){e.file=Se(e);let n=e.file&&un(e.file);return n?(e.args.unshift(e.file),e.command=n,Se(e)):e.file}function dn(e){if(!fn)return e;let n=pn(e),t=!ln.test(n);if(e.options.forceShell||t){let r=mn.test(n);e.command=an.normalize(e.command),e.command=Ne.command(e.command),e.args=e.args.map(o=>Ne.argument(o,r));let s=[e.command].concat(e.args).join(" ");e.args=["/d","/s","/c",`"${s}"`],e.command=process.env.comspec||"cmd.exe",e.options.windowsVerbatimArguments=!0}return e}function hn(e,n,t){n&&!Array.isArray(n)&&(t=n,n=null),n=n?n.slice(0):[],t=Object.assign({},t);let r={command:e,args:n,options:t,file:void 0,original:{command:e,args:n}};return t.shell?r:dn(r)}Oe.exports=hn});var be=f((Yn,Pe)=>{"use strict";var k=process.platform==="win32";function L(e,n){return Object.assign(new Error(`${n} ${e.command} ENOENT`),{code:"ENOENT",errno:"ENOENT",syscall:`${n} ${e.command}`,path:e.command,spawnargs:e.args})}function En(e,n){if(!k)return;let t=e.emit;e.emit=function(r,s){if(r==="exit"){let o=Ce(s,n);if(o)return t.call(e,"error",o)}return t.apply(e,arguments)}}function Ce(e,n){return k&&e===1&&!n.file?L(n.original,"spawn"):null}function yn(e,n){return k&&e===1&&!n.file?L(n.original,"spawnSync"):null}Pe.exports={hookChildProcess:En,verifyENOENT:Ce,verifyENOENTSync:yn,notFoundError:L}});var qe=f((Zn,x)=>{"use strict";var Ae=h("child_process"),G=Te(),U=be();function $e(e,n,t){let r=G(e,n,t),s=Ae.spawn(r.command,r.args,r.options);return U.hookChildProcess(s,r),s}function vn(e,n,t){let r=G(e,n,t),s=Ae.spawnSync(r.command,r.args,r.options);return s.error=s.error||U.verifyENOENTSync(s.status,r),s}x.exports=$e;x.exports.spawn=$e;x.exports.sync=vn;x.exports._parse=G;x.exports._enoent=U});var _e=z(qe()),D=z(_());import{spawn as xn}from"node:child_process";import{normalize as gn}from"node:path";import{mkdirSync as Re,readFileSync as Sn,realpathSync as Nn}from"node:fs";import{homedir as On}from"node:os";import{dirname as Tn,isAbsolute as Cn,join as ke,resolve as g,sep as Pn}from"node:path";import{fileURLToPath as bn}from"node:url";function wn({cwd:e,command:n,args:t,env:r}){let s=r===void 0?{cwd:e,stdio:"inherit"}:{cwd:e,stdio:"inherit",env:r},o=_e.default._parse(n,t,s);if(process.platform==="win32"&&/\.(cmd|bat)$/i.test(o.file??"")){let i=[D.default.command(gn(o.file)),...t.map(u=>D.default.argument(u,!0))].join(" ");o.args=["/d","/s","/c",'"'+i+'"']}let c=xn(o.command,o.args,o.options);for(let i of["SIGINT","SIGTERM"])process.on(i,()=>c.kill(i));c.on("error",i=>{console.error(i.message),process.exitCode=1}),c.on("exit",(i,u)=>{u?(process.removeAllListeners(u),process.kill(process.pid,u)):process.exitCode=i??1})}var An="${PLUGIN_ROOT}",$n="${PLUGIN_DATA}",qn="../package",jn="combined-example",In="mcp-servers.json",_n=!1,Le=Tn(bn(import.meta.url)),w=g(Le,qn);function E(e){console.error("hooknostic mcp-launcher: "+e),process.exit(1)}function je(e){try{return Nn.native(e)}catch{return g(e)}}function Rn(){let e=process.env.PLUGIN_ROOT,n=process.env.PLUGIN_DATA;if(!(!e||!n||!Cn(n)))return je(e)===je(w)?n:void 0}var Ge=Rn(),T=Ge??ke(On(),".hooknostic","plugin-data",jn);if(Ge===void 0)try{Re(T,{recursive:!0})}catch(e){E("could not create the plugin data directory "+T+": "+e.message)}var C=ke(Le,In),O;try{O=JSON.parse(Sn(C,"utf8"))}catch(e){E("could not read "+C+": "+e.message)}(O===null||typeof O!="object"||!Array.isArray(O.servers))&&E(C+" declares no servers array");var F=Number(process.argv[2]),l=Number.isInteger(F)?O.servers[F]:void 0;(l===null||typeof l!="object")&&E("no server at index "+JSON.stringify(process.argv[2])+" in "+C);typeof l.command!="string"&&E("server at index "+F+" in "+C+" declares no command");function M(e){let n=e.split(An).join(w).split($n).join(T);return _n?n.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,(t,r,s)=>{let o=process.env[r];if(o!==void 0)return o;if(s!==void 0)return s;E("environment variable "+r+" is required by "+t)}):n}var N=l.cwd===void 0?w:l.cwd.startsWith("./")?g(w,l.cwd):g(M(l.cwd)),kn=l.command.startsWith("./")?g(w,l.command):l.command,Ln=(l.args??[]).map(M),b=Object.assign(Object.create(null),process.env);for(let[e,n]of Object.entries(l.env??{}))b[e]=M(n);b.PLUGIN_ROOT=w;b.PLUGIN_DATA=T;var Ie=g(T);if(N===Ie||N.startsWith(Ie+Pn))try{Re(N,{recursive:!0})}catch(e){E("could not create the working directory "+N+": "+e.message)}wn({cwd:N,command:kn,args:Ln,env:b});

/*!
Bundled package notices

cross-spawn@7.0.6
LICENSE
The MIT License (MIT)

Copyright (c) 2018 Made With MOXY Lda <hello@moxy.studio>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

---

hooknostic@0.1.0
LICENSE
Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright [yyyy] [name of copyright owner]

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.

---

isexe@2.0.0
which@2.0.2
LICENSE
The ISC License

Copyright (c) Isaac Z. Schlueter and Contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF OR
IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.

---

path-key@3.1.1
shebang-regex@3.0.0
license
MIT License

Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (sindresorhus.com)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

---

shebang-command@2.0.0
license
MIT License

Copyright (c) Kevin Mårtensson <kevinmartensson@gmail.com> (github.com/kevva)

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
*/
