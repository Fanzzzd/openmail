export const hiddenDraftProbes = [
  '<div style="background:#111"><span style="color:#000000">SECRET</span></div>',
  '<div style="background:#111"><span style="color:#0d0d0d">SECRET</span></div>',
  '<p style="color:#000;box-shadow:inset 0 0 0 200px #000">SECRET</p>',
  '<div style="background:#000"><span style="color:windowtext">SECRET</span></div>',
  '<style>.dark{background:#000}</style><div class="dark"><span style="color:windowtext">SECRET</span></div>',
  '<table bgcolor="#000000"><tr><td><span style="color:windowtext">SECRET</span></td></tr></table>',
  '<div style="background:#000"><span>SECRET</span></div>',
  '<style>.dark{background:#000}</style><div class="dark"><span>SECRET</span></div>',
  '<table bgcolor="#000000"><tr><td><span>SECRET</span></td></tr></table>',
  '<style>.hidden{color:#fff;background-color:#fff}p{color:#000}</style><p class="hidden">SECRET</p>',
  '<p style="display:none">SECRET</p>',
  '<p style="visibility:hidden">SECRET</p>',
  '<p style="opacity:0">SECRET</p>',
  '<p style="font-size:0">SECRET</p>',
  '<p style="width:0;height:0;overflow:hidden">SECRET</p>',
  '<p style="position:absolute;left:-9999px">SECRET</p>',
  '<p style="color:#fff;background-color:#fff">SECRET</p>',
  '<style>.hidden{display:none}</style><p class="hidden">SECRET</p>',
  '<style>p::after{content:"HIDDEN-AFTER"}p::before{content:"SECRET"}</style>',
  '<p style="background:url(https://remote.test/background)">Visible</p>',
  '<img src="https://remote.test/image">',
  '<img src="data:image/png;base64,aGk=">',
];

// Hand-written structural examples; no user mail or provider calls.
export const clientHtmlDrafts = [
  {
    client: "Gmail web",
    html: '<div dir="ltr">Hi <b>Bob</b><ul><li>First</li><li>Second</li></ul><div class="gmail_signature" data-smartmail="gmail_signature">Regards<br>Alice<img src="cid:logo%40example.com"></div></div><div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">On Tuesday Bob wrote:</div><blockquote class="gmail_quote" style="margin:0px 0px 0px 0.8ex;border-left:1px solid #ccc;padding-left:1ex"><div dir="ltr"><b>Quoted reply</b></div></blockquote></div>',
  },
  {
    client: "Outlook web",
    html: '<html><head><meta charset="utf-8"><style type="text/css" style="display:none;"> P {margin-top:0;margin-bottom:0;} </style></head><body><div class="elementToProof" style="font-family: Aptos, Aptos_EmbeddedFont, Aptos_MSFontService, Calibri, Helvetica, sans-serif; font-size:12pt; color: rgb(0,0,0)">Hi <b>Bob</b><ul><li>First</li><li>Second</li></ul><div id="Signature"><font face="Calibri, sans-serif" size="2" color="#000">Regards</font><br>Alice<img src="cid:logo%40example.com"></div></div><hr style="display:inline-block;width:98%" tabindex="-1"><div id="divRplyFwdMsg"><p>On Tuesday Bob wrote:</p></div><blockquote><p><b>Quoted reply</b></p></blockquote></body></html>',
  },
  {
    client: "Apple Mail",
    html: '<html><head><meta charset="utf-8"></head><body style="word-wrap:break-word;-webkit-nbsp-mode:space;line-break:after-white-space;font-family:Helvetica;font-size:12px">Hi <b>Bob</b><ul><li>First</li><li>Second</li></ul><div class="AppleMailSignature">Regards<br>Alice<img apple-inline="yes" id="apple-logo" src="cid:logo@example.com" height="80" width="240"></div><div>On Tuesday Bob wrote:</div><blockquote type="cite" style="margin:0"><div><b>Quoted reply</b></div></blockquote></body></html>',
  },
];

// Exact redacted Outlook desktop fixture supplied for the MSO regression.
export const outlookMsoDraftHtml =
  '<html><head>\n<meta http-equiv="Content-Type" content="text/html; charset=utf-8"><meta name="ProgId" content="Word.Document"><meta name="Generator" content="Microsoft Word 15"><meta name="Originator" content="Microsoft Word 15"><style>\n<!--\n@font-face\n\t{font-family:"Cambria Math"}\n@font-face\n\t{font-family:DengXian}\n@font-face\n\t{font-family:Calibri}\n@font-face\n\t{font-family:Aptos}\n@font-face\n\t{}\np.MsoNormal, li.MsoNormal, div.MsoNormal\n\t{margin:0cm;\n\tfont-size:12.0pt;\n\tfont-family:"Calibri",sans-serif}\na:link, span.MsoHyperlink\n\t{color:#0563C1;\n\ttext-decoration:underline}\na:visited, span.MsoHyperlinkFollowed\n\t{color:#954F72;\n\ttext-decoration:underline}\nspan.EmailStyle17\n\t{font-family:"Calibri",sans-serif;\n\tcolor:windowtext}\n.MsoChpDefault\n\t{}\n@page WordSection1\n\t{margin:72.0pt 72.0pt 72.0pt 72.0pt}\ndiv.WordSection1\n\t{}\n-->\n</style></head><body lang="EN-HK" link="#0563C1" vlink="#954F72" style="word-wrap:break-word"><div class="WordSection1"><p class="MsoNormal">&nbsp;</p><p class="MsoNormal">Hello <b>there</b></p><p class="MsoNormal"><a name="_MailAutoSig"><span style="font-family:&quot;Aptos&quot;,sans-serif">Get </span></a><a href="https://aka.ms/GetOutlookForMac"><span style=""><span style="font-family:&quot;Aptos&quot;,sans-serif; color:blue">Outlook for Mac </span></span><span style=""></span></a><span style=""></span></p></div></body></html>';

export const outlookWindowsReplyHtml =
  '<html><head><style><!--\np.MsoNormal,li.MsoNormal,div.MsoNormal{margin:0cm;font-size:12.0pt;font-family:"Calibri",sans-serif}\n--></style></head><body lang="EN-US" style="word-wrap:break-word"><div class="WordSection1"><p class="MsoNormal">Answer <b>there</b></p><div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0cm 0cm 0cm"><p class="MsoNormal"><b>From:</b> Alice &lt;alice@example.com&gt;<br><b>Sent:</b> Tuesday, October 6, 2026<br><b>To:</b> Bob &lt;bob@example.com&gt;<br><b>Subject:</b> Example</p></div><blockquote><p class="MsoNormal">Quoted original</p></blockquote></div></body></html>';
