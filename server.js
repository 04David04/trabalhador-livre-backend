require("dotenv").config();

const bcrypt = require("bcrypt");
const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const multer = require("multer");
const crypto = require("crypto");
const { Resend } = require("resend");

const resend = new Resend(process.env.RESEND_API_KEY);

// ------------------------------------------------------------------
// HELPERS
// ------------------------------------------------------------------
function extrairCaminhoBucket(urlFoto, bucket = "profissionais") {
  if (!urlFoto) return null;
  try {
    const partes = urlFoto.split(`/storage/v1/object/public/${bucket}/`);
    return partes.length > 1 ? partes[1] : null;
  } catch (e) {
    return null;
  }
}

const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ------------------------------------------------------------------
// SUPABASE
// ------------------------------------------------------------------
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabase = createClient(supabaseUrl, supabaseServiceKey);

const upload = multer({ storage: multer.memoryStorage() });

// ------------------------------------------------------------------
// UPLOAD GENÉRICO
// ------------------------------------------------------------------
async function uploadParaStorage(file, bucket, pasta = "") {
  const ext = file.originalname.split(".").pop();
  const nomeLimpo = file.originalname
    .replace(/\.[^/.]+$/, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9-_]/g, "");
  const fileName = `${Date.now()}-${nomeLimpo}.${ext}`;
  const filePath = pasta ? `${pasta}/${fileName}` : fileName;

  const { error: uploadError } = await supabase.storage
    .from(bucket)
    .upload(filePath, file.buffer, {
      contentType: file.mimetype,
      upsert: true,
    });

  if (uploadError) throw uploadError;

  const { data: publicUrlData } = supabase.storage
    .from(bucket)
    .getPublicUrl(filePath);

  return publicUrlData.publicUrl;
}

// ==================================================================
// ROTAS PÚBLICAS
// ==================================================================

// 1. Listar profissionais PÚBLICOS (Apenas Aprovados, Não Bloqueados e Não Excluídos)
app.get("/api/profissionais", async (req, res) => {
  try {
    // Busca apenas profissionais aptos para exibição pública com ordenação por destaque
    const { data: profissionais, error: errProf } = await supabase
      .from("profissionais")
      .select("*")
      .eq("condicao", "Aprovado")
      .eq("bloqueado", false)
      .or("excluido.is.null,excluido.eq.false")
      .order("destaque", { ascending: false })
      .order("status", { ascending: true })
      .order("created_at", { ascending: false });

    if (errProf) throw errProf;

    // Busca avaliações APROVADAS
    const { data: avaliacoesAprovadas, error: errAval } = await supabase
      .from("avaliacoes")
      .select("profissional, ponto")
      .eq("status", "APROVADO");

    if (errAval) throw errAval;

    // Agrupa avaliações por profissional
    const statsPorProf = {};
    (avaliacoesAprovadas || []).forEach((a) => {
      if (!statsPorProf[a.profissional]) {
        statsPorProf[a.profissional] = { soma: 0, total: 0 };
      }
      statsPorProf[a.profissional].soma += Number(a.ponto) || 0;
      statsPorProf[a.profissional].total += 1;
    });

    // Enriquece com média + total de avaliações
    const resultado = profissionais.map((p) => {
      const stats = statsPorProf[p.id] || { soma: 0, total: 0 };
      const media = stats.total > 0 ? stats.soma / stats.total : 0;

      return {
        ...p,
        avaliacao: Number(media.toFixed(2)),
        total_avaliacoes: stats.total,
        pontosTotais: stats.soma,
      };
    });

    res.json(resultado);
  } catch (error) {
    console.error("Erro ao listar profissionais públicos:", error);
    res.status(500).json({ error: error.message });
  }
});

// 2. Cliente envia avaliação
app.post("/api/avaliacoes", async (req, res) => {
  try {
    const { profissional, contacto, classificacao, ponto, comentario, nome, email } =
      req.body;

    if (!profissional || ponto === undefined || !classificacao || !comentario || !nome) {
      return res.status(400).json({
        error:
          "Por favor, preencha os campos obrigatórios: classificação, comentário, nome e contacto.",
      });
    }

    const { data, error } = await supabase.from("avaliacoes").insert([
      {
        classificacao,
        comentario,
        status: "PENDENTE",
        profissional,
        ponto,
        contacto: contacto || "Anónimo",
        nome,
        email,
      },
    ]);

    if (error) throw error;

    res.status(201).json({
      message: "Avaliação enviada com sucesso! Aguarda aprovação do Admin.",
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// 3. Listar áreas
app.get("/api/areas", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("areas")
      .select("*")
      .order("nome", { ascending: true });

    if (error) throw error;
    return res.status(200).json(data);
  } catch (err) {
    console.error("Erro ao listar áreas:", err);
    return res.status(500).json({ error: "Erro ao carregar as áreas." });
  }
});

// 4. Cadastro de profissional
app.post("/api/profissionais", upload.single("foto"), async (req, res) => {
  try {
    const {
      nome, profissao, status, telefone, whatsapp, paisContacto, paisWhat,
      email, localizacao, trabalho, domicilio, senha,
    } = req.body;

    let fotoUrl = null;

    if (req.file) {
      fotoUrl = await uploadParaStorage(req.file, "profissionais");
    }

    const senhaHash = await bcrypt.hash(senha, 10);

    // Tratamento para garantir que paisContacto e paisWhat fiquem +258
    const paisContactoFinal = paisContacto && paisContacto !== "undefined" ? paisContacto : "+258";
    const paisWhatFinal = paisWhat && paisWhat !== "undefined" ? paisWhat : "+258";

    const { data, error } = await supabase
      .from("profissionais")
      .insert([
        {
          nome,
          profissao,
          status: status || "Disponível",
          telefone,
          whatsapp,
          paisContacto: paisContactoFinal,
          paisWhat: paisWhatFinal,
          email: email.toLowerCase(),
          localizacao,
          trabalho,
          domicilio: domicilio || "Sim",
          foto: fotoUrl,
          verificado: false,
          visualizacoes: 0,
          trabalhos_realizados: 0,
          avaliacao: 0.0,
          condicao: "Pendente",
          senha: senhaHash,
        },
      ])
      .select();

    if (error) throw error;

    res.status(201).json({ message: "Profissional cadastrado com sucesso!", data });
  } catch (error) {
    console.error("Erro no cadastro:", error);
    res.status(500).json({
      error: error.message || "Erro interno ao cadastrar profissional.",
    });
  }
});

// 5. Login
app.post("/api/login", async (req, res) => {
  try {
    const { login, senha } = req.body || {};
    if (!login || !senha) {
      return res.status(400).json({ error: "Por favor, preencha o contacto/e-mail e a senha." });
    }

    const termo = login.trim();

    const { data: porTelefone } = await supabase
      .from("profissionais")
      .select("*")
      .eq("telefone", termo)
      .maybeSingle();

    const { data: porEmail } = await supabase
      .from("profissionais")
      .select("*")
      .eq("email", termo.toLowerCase())
      .maybeSingle();

    const profissional = porTelefone || porEmail;

    if (!profissional) {
      return res.status(404).json({ error: "Contacto/e-mail incorreto.", tipo: "1" });
    }

    if (profissional.excluido) {
      return res.status(403).json({ error: "Esta conta foi removida." });
    }

    if (!profissional.senha) {
      return res.status(401).json({
        error: "Este profissional não tem senha válida no sistema.",
        tipo: "2",
      });
    }

    const senhaValida = await bcrypt.compare(senha, profissional.senha);
    if (!senhaValida) {
      return res.status(401).json({ error: "Senha incorreta.", tipo: "2" });
    }

    delete profissional.senha;

    res.status(200).json({ message: "Login efetuado com sucesso!", profissional });
  } catch (error) {
    console.error("Erro no login:", error);
    res.status(500).json({ error: error.message || "Erro interno no servidor." });
  }
});

// 6. Verificar email
app.post("/api/login/verificar", async (req, res) => {
  try {
    const { email } = req.body || {};
    if (!email) return res.status(400).json({ error: "Por favor, preencha o e-mail." });

    const { data: profissional, error } = await supabase
      .from("profissionais")
      .select("*")
      .eq("email", email.toLowerCase())
      .maybeSingle();

    if (error || !profissional) {
      return res.status(404).json({ error: "Nenhuma conta encontrada.", tipo: "0" });
    }

    res.status(200).json({ message: "Conta encontrada!" });
  } catch (error) {
    console.error("Erro no login/verificar:", error);
    res.status(500).json({ error: error.message || "Erro interno no servidor." });
  }
});

// 7. Atualizar perfil
app.put("/api/profissionais/:id", upload.single("foto"), async (req, res) => {
  try {
    const { id } = req.params;
    const {
      nome, status, telefone, whatsapp, email, profissao,
      localizacao, trabalho, domicilio, paisContacto, paisWhat,
    } = req.body;

    const { data: profissionalAtual, error: erroBusca } = await supabase
      .from("profissionais")
      .select("foto")
      .eq("id", id)
      .single();

    if (erroBusca || !profissionalAtual) {
      return res.status(404).json({ error: "Profissional não encontrado." });
    }

    let novaFotoUrl = profissionalAtual.foto;

    if (req.file) {
      const caminhoAntigo = extrairCaminhoBucket(profissionalAtual.foto, "profissionais");
      if (caminhoAntigo) {
        await supabase.storage.from("profissionais").remove([caminhoAntigo]);
      }
      novaFotoUrl = await uploadParaStorage(req.file, "profissionais", "perfis");
    }

    const paisContactoFinal = paisContacto && paisContacto !== "undefined" ? paisContacto : "+258";
    const paisWhatFinal = paisWhat && paisWhat !== "undefined" ? paisWhat : "+258";

    const { data: profissionalAtualizado, error: updateError } = await supabase
      .from("profissionais")
      .update({
        nome, status, telefone, whatsapp,
        email: email.toLowerCase(),
        profissao,
        localizacao, trabalho, domicilio,
        paisContacto: paisContactoFinal,
        paisWhat: paisWhatFinal,
        foto: novaFotoUrl,
      })
      .eq("id", id)
      .select();

    if (updateError) {
      console.error("Erro ao atualizar banco:", updateError);
      return res.status(500).json({ error: "Erro ao guardar as alterações no perfil." });
    }

    return res.status(200).json({
      message: "Perfil atualizado com sucesso!",
      profissional: profissionalAtualizado[0],
    });
  } catch (error) {
    console.error("Erro na atualização do perfil:", error);
    return res.status(500).json({ error: "Erro interno ao atualizar perfil." });
  }
});

// 8. Esqueci a senha
app.post("/api/esquecisenha", async (req, res) => {
  try {
    const email = String(req.body?.email || "").trim().toLowerCase();
    console.log("✓ 1. Email recebido:", email);
    
    if (!email) return res.status(400).json({ error: "E-mail obrigatório." });

    const { data: profissional, error } = await supabase
      .from("profissionais")
      .select("*")
      .eq("email", email)
      .maybeSingle();

    console.log("✓ 2. Profissional encontrado:", profissional?.nome || "NÃO");

    if (error || !profissional) {
      return res.status(404).json({ error: "E-mail não encontrado." });
    }

    const resetToken = crypto.randomBytes(32).toString("hex");
    const tokenExpira = new Date(Date.now() + 30 * 60 * 1000).toISOString();

    const { error: updateError } = await supabase
      .from("profissionais")
      .update({ reset_token: resetToken, reset_expira: tokenExpira })
      .eq("id", profissional.id);

    if (updateError) throw updateError;
    console.log("✓ 3. Token atualizado no BD");

    const frontendUrl = process.env.FRONTEND_URL;
    const linkRedefinicao = `${frontendUrl}/?token=${resetToken}&Page=1`;

    console.log("⏳ 4. A enviar email para:", email);
    console.log("API Key existe?", !!process.env.RESEND_API_KEY);

    const { data: emailData, error: emailError } = await resend.emails.send({
      from: "noreply@resend.dev",
      to: email,
      subject: "Recuperação de Conta - Redefinir Senha",
      html: `<p>Olá ${profissional.nome}, clica <a href="${linkRedefinicao}">aqui</a> para redefinir a senha.</p>`,
    });

    console.log("❌ Erro do Resend:", emailError);
    console.log("✓ Resposta do Resend:", emailData);

    if (emailError) {
      console.error("ERRO DETALHADO:", JSON.stringify(emailError));
      throw emailError;
    }

    return res.status(200).json({ message: "E-mail de recuperação enviado com sucesso!" });
  } catch (err) {
    console.error("❌ ERRO COMPLETO:", JSON.stringify(err, null, 2));
    return res.status(500).json({ error: "Erro ao processar pedido de recuperação." });
  }
});


// 9. Redefinir senha
app.post("/api/redefinir-senha", async (req, res) => {
  const { token, novaSenha } = req.body;

  try {
    const { data: profissional, error } = await supabase
      .from("profissionais")
      .select("*")
      .eq("reset_token", token)
      .single();

    if (error || !profissional) {
      return res.status(400).json({ error: "Token inválido ou expirado." });
    }

    if (new Date() > new Date(profissional.reset_expira)) {
      return res.status(400).json({ error: "O link de recuperação expirou. Pede um novo link." });
    }

    const senhaHash = await bcrypt.hash(novaSenha, 10);

    await supabase
      .from("profissionais")
      .update({ senha: senhaHash, reset_token: null, reset_expira: null })
      .eq("id", profissional.id);

    return res.status(200).json({ message: "Senha redefinida com sucesso! Já podes fazer login." });
  } catch (err) {
    return res.status(500).json({ error: "Erro ao redefinir palavra-passe." });
  }
});

// 10. Histórico de avaliações do profissional logado
app.get("/api/profissionais/:id/avaliacoes", async (req, res) => {
  const { id } = req.params;
  try {
    const { data, error } = await supabase
      .from("avaliacoes")
      .select("*")
      .eq("profissional", id)
      .order("created_at", { ascending: false });

    if (error) throw error;
    res.status(200).json(data || []);
  } catch (erro) {
    console.error("Erro ao buscar avaliações:", erro.message);
    res.status(500).json({ error: "Erro ao carregar histórico de avaliações." });
  }
});

// ==================================================================
// ROTAS DE ADMINISTRAÇÃO
// ==================================================================

// ---- PROFISSIONAIS ----

// Listar TODOS os profissionais para a tabela de Admin (Apenas ignora excluídos)
app.get("/api/admin/profissionais", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("profissionais")
      .select("*")
      .or("excluido.is.null,excluido.eq.false")
      .order("created_at", { ascending: false });

    if (error) throw error;
    return res.status(200).json(data || []);
  } catch (err) {
    console.error("Erro ao listar todos os profissionais para o Admin:", err.message);
    return res.status(500).json({ error: "Erro ao carregar a lista do painel administrativo." });
  }
});

app.patch("/api/admin/profissionais/:id/condicao", async (req, res) => {
  const { id } = req.params;
  const { condicao } = req.body;

  if (!["Aprovado", "Rejeitado", "Pendente"].includes(condicao)) {
    return res.status(400).json({ error: "Condição inválida." });
  }

  try {
    const { data, error } = await supabase
      .from("profissionais")
      .update({ condicao })
      .eq("id", id)
      .select();

    if (error) throw error;

    return res.status(200).json({
      message: `Profissional ${condicao.toLowerCase()} com sucesso!`,
      profissional: data[0],
    });
  } catch (err) {
    console.error("Erro ao atualizar condição:", err);
    return res.status(500).json({ error: "Erro ao atualizar estado do profissional." });
  }
});

app.patch("/api/admin/profissionais/:id/status", async (req, res) => {
  const { id } = req.params;
  const { verificado, destaque, bloqueado } = req.body;

  const campos = {};
  if (typeof verificado !== "undefined") campos.verificado = verificado;
  if (typeof destaque !== "undefined") campos.destaque = destaque;
  if (typeof bloqueado !== "undefined") campos.bloqueado = bloqueado;

  if (Object.keys(campos).length === 0) {
    return res.status(400).json({ error: "Nenhum campo válido enviado." });
  }

  try {
    const { data, error } = await supabase
      .from("profissionais")
      .update(campos)
      .eq("id", id)
      .select();

    if (error) throw error;

    return res.status(200).json({
      message: "Status atualizado com sucesso!",
      profissional: data[0],
    });
  } catch (err) {
    console.error("Erro ao atualizar status:", err);
    return res.status(500).json({ error: "Erro ao atualizar status do profissional." });
  }
});

app.delete("/api/admin/profissionais/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const { data, error } = await supabase
      .from("profissionais")
      .update({ excluido: true })
      .eq("id", id)
      .select();

    if (error) throw error;

    return res.status(200).json({
      message: "Profissional movido para a lixeira com sucesso!",
      profissional: data[0],
    });
  } catch (err) {
    console.error("Erro ao excluir profissional:", err);
    return res.status(500).json({ error: "Erro ao excluir profissional." });
  }
});

// ---- CATEGORIAS / ÁREAS ----

app.post(
  "/api/admin/categorias",
  upload.single("foto"),
  async (req, res) => {
    const { nome, oque_faz, quando_chamar } = req.body;

    if (!nome || !nome.trim()) {
      return res.status(400).json({ mensagem: "O nome da área é obrigatório." });
    }

    try {
      let fotoUrl = null;

      if (req.file) {
        fotoUrl = await uploadParaStorage(req.file, "profissionais", "areas");
      } else if (req.body.foto && typeof req.body.foto === "string") {
        fotoUrl = req.body.foto.trim();
      }

      const { data, error } = await supabase
        .from("areas")
        .insert([
          {
            nome: nome.trim(),
            foto: fotoUrl,
            oque_faz: oque_faz ? oque_faz.trim() : null,
            quando_chamar: quando_chamar ? quando_chamar.trim() : null,
          },
        ])
        .select();

      if (error) throw error;

      return res.status(201).json(data[0]);
    } catch (err) {
      console.error("Erro ao cadastrar categoria:", err.message);
      return res.status(500).json({ mensagem: "Erro interno ao guardar a categoria." });
    }
  }
);

app.delete("/api/admin/categorias/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const { data: categoria } = await supabase
      .from("areas")
      .select("foto")
      .eq("id", id)
      .maybeSingle();

    if (categoria?.foto) {
      const caminho = extrairCaminhoBucket(categoria.foto, "profissionais");
      if (caminho) {
        await supabase.storage.from("profissionais").remove([caminho]);
      }
    }

    const { error } = await supabase.from("areas").delete().eq("id", id);
    if (error) throw error;

    return res.status(200).json({ mensagem: "Categoria eliminada com sucesso." });
  } catch (err) {
    console.error("Erro ao eliminar categoria:", err.message);
    return res.status(500).json({ mensagem: "Erro ao eliminar a categoria." });
  }
});

app.get("/api/categorias", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("categorias")
      .select("*")
      .order("nome", { ascending: true });

    if (error) throw error;
    return res.status(200).json(data);
  } catch (err) {
    console.error("Erro ao procurar categorias:", err.message);
    return res.status(500).json({ mensagem: "Erro ao procurar categorias." });
  }
});

// ---- AVALIAÇÕES ----

app.get("/api/admin/avaliacoes", async (req, res) => {
  try {
    const { data, error } = await supabase
      .from("avaliacoes")
      .select(`
        *,
        profissionais:profissional (
          id,
          nome,
          profissao,
          foto,
          localizacao
        )
      `)
      .order("created_at", { ascending: false });

    if (error) throw error;

    return res.status(200).json(data || []);
  } catch (err) {
    console.error("Erro ao listar avaliações:", err.message);
    return res.status(500).json({ error: "Erro ao carregar avaliações." });
  }
});

app.patch("/api/admin/avaliacoes/:id/status", async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!["APROVADO", "REJEITADO", "PENDENTE"].includes(status)) {
    return res.status(400).json({ error: "Status inválido." });
  }

  try {
    const { data, error } = await supabase
      .from("avaliacoes")
      .update({ status })
      .eq("id", id)
      .select();

    if (error) throw error;

    return res.status(200).json({
      message: `Avaliação ${status.toLowerCase()} com sucesso!`,
      avaliacao: data[0],
    });
  } catch (err) {
    console.error("Erro ao atualizar status da avaliação:", err.message);
    return res.status(500).json({ error: "Erro ao atualizar avaliação." });
  }
});

app.delete("/api/admin/avaliacoes/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const { error } = await supabase.from("avaliacoes").delete().eq("id", id);
    if (error) throw error;

    return res.status(200).json({ mensagem: "Avaliação apagada com sucesso." });
  } catch (err) {
    console.error("Erro ao apagar avaliação:", err.message);
    return res.status(500).json({ error: "Erro ao apagar avaliação." });
  }
});

// ==================================================================
// LISTEN
// ==================================================================
app.listen(5000, () => {
  console.log("Servidor rodando na porta 5000");
});