require("dotenv").config(); // Carrega as variáveis do .env
const bcrypt = require("bcrypt");
const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const multer = require("multer");
const nodemailer = require('nodemailer');
const crypto = require('crypto');


const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER, // Teu e-mail
    pass: process.env.EMAIL_PASS  // Tua Senha de Aplicação do Gmail
  }
})

// Extrai o caminho do ficheiro no Bucket a partir da URL completa
function extrairCaminhoBucket(urlFoto) {
  if (!urlFoto) return null;
  try {
    const partes = urlFoto.split("/storage/v1/object/public/profissionais/");
    return partes.length > 1 ? partes[1] : null;
  } catch (e) {
    return null;
  }
}
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 1. Pega as variáveis de ambiente
const supabaseUrl = process.env.SUPABASE_URL;
// Usamos a SERVICE_ROLE_KEY para ignorar as restrições de RLS no servidor
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

// 2. Cria o cliente Supabase com a Chave de Administrador (Service Role)
const supabase = createClient(supabaseUrl, supabaseServiceKey);

// Configuração do Multer para receber ficheiros na memória
const upload = multer({ storage: multer.memoryStorage() });

// Rota de teste inicial
app.get("/", (req, res) => {
  res.send("O meu servidor está VIVO e configurado!");
});

// 2. ROTA REAL: Buscar a lista de profissionais da base de dados
app.get("/api/profissionais", async (req, res) => {
  try {
    // Consulta a tabela 'profissionais' do Supabase
    const { data, error } = await supabase.from("profissionais").select("*");

    if (error) throw error;

    // Retorna os dados em formato JSON para o Front-end
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ROTA 2: Cliente envia uma avaliação sobre um profissional
app.post("/api/avaliacoes", async (req, res) => {
  try {
    // 1. Extraímos os dados que o cliente envia no formulário
    const { profissional, contacto, classificacao, ponto, comentario } =
      req.body;

    // 1.a Validação de campos obrigatórios
    if (!profissional || !ponto || !classificacao || !comentario) {
      return res.status(400).json({
        error:
          "Por favor, preencha os campos obrigatórios: classificação e comentário.",
      });
    }

    // 2. Inserimos a nova avaliação na tabela 'avaliacoes'
    const { data, error } = await supabase.from("avaliacoes").insert([
      {
        classificacao,
        comentario,
        status: "PENDENTE", // Todas as avaliações entram em moderação por padrão
        profissional,
        ponto,
        contacto: contacto || "Anónimo",
      },
    ]);

    if (error) throw error;

    // 3. Resposta de sucesso enviada de volta ao cliente
    res.status(201).json({
      message: "Avaliação enviada com sucesso! Aguarda aprovação do Admin.",
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

/* =========================================================
   ROTAS DE ADMINISTRAÇÃO (MODERAÇÃO)
   ========================================================= */

// 1. Admin busca todas as avaliações (podes filtrar por status: ?status=PENDENTE)
app.get("/api/admin/avaliacoes", async (req, res) => {
  try {
    const { status } = req.query; // Pega o parâmetro da URL (ex: ?status=PENDENTE)

    let query = supabase
      .from("avaliacoes")
      .select("*, profissionais(nome, profissao)");

    if (status) {
      query = query.eq("status", status);
    }

    const { data, error } = await query.order("created_at", {
      ascending: false,
    });

    if (error) throw error;
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 2. Admin APROVA a avaliação e SOMA os pontos ao profissional
app.patch("/api/admin/avaliacoes/:id/aprovar", async (req, res) => {
  try {
    const { id } = req.params; // ID da avaliação
    const { profissional_id, pontos } = req.body; // Dados vindos do Front-end

    // A. Mudar o status da avaliação para APROVADO
    const { error: errorAval } = await supabase
      .from("avaliacoes")
      .update({ status: "APROVADO" })
      .eq("id", id);

    if (errorAval) throw errorAval;

    // B. Buscar os pontos atuais do profissional
    const { data: prof, error: errorProf } = await supabase
      .from("profissionais")
      .select("pontos_totais")
      .eq("id", profissional_id)
      .single();

    if (errorProf) throw errorProf;

    // C. Calcular a nova pontuação e atualizar o profissional
    const novaPontuacao = (prof.pontos_totais || 0) + Number(pontos);

    const { error: errorUpdate } = await supabase
      .from("profissionais")
      .update({ pontos_totais: novaPontuacao })
      .eq("id", profissional_id);

    if (errorUpdate) throw errorUpdate;

    res.json({
      message: "Avaliação aprovada e pontos do profissional atualizados!",
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// 3. Admin REJEITA a avaliação
app.patch("/api/admin/avaliacoes/:id/rejeitar", async (req, res) => {
  try {
    const { id } = req.params;

    const { error } = await supabase
      .from("avaliacoes")
      .update({ status: "REJEITADO" })
      .eq("id", id);

    if (error) throw error;
    res.json({ message: "Avaliação rejeitada." });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

// ROTA: Cadastrar novo profissional com Foto Automática
app.post("/api/profissionais", upload.single("foto"), async (req, res) => {
  try {
    const {
      nome,
      profissao,
      status,
      telefone,
      whatsapp,
      email,
      localizacao,
      trabalho,
      domicilio,
      senha,
    } = req.body;

    let fotoUrl = null;

    // Se o utilizador enviou uma foto no formulário
    if (req.file) {
      const file = req.file;
      const fileName = `${Date.now()}-${file.originalname.replace(/\s+/g, "-")}`;

      // Upload para o Bucket 'profissionais' no Supabase Storage
      const { data: storageData, error: storageError } = await supabase.storage
        .from("profissionais")
        .upload(fileName, file.buffer, {
          contentType: file.mimetype,
          upsert: true,
        });

      if (storageError) throw storageError;

      // Pega a URL pública da imagem
      const { data: publicUrlData } = supabase.storage
        .from("profissionais")
        .getPublicUrl(fileName);

      fotoUrl = publicUrlData.publicUrl;
    }

    const saltRounds = 10;
    const senhaHash = await bcrypt.hash(senha, saltRounds);

    // Inserir os dados no banco PostgreSQL / Supabase
    const { data, error } = await supabase
      .from("profissionais")
      .insert([
        {
          nome,
          profissao,
          status: status || "Disponível",
          telefone,
          whatsapp,
          email,
          localizacao,
          trabalho,
          domicilio: domicilio || "Sim",
          foto: fotoUrl,
          verificado: false,
          visualizacoes: 0,
          trabalhos_realizados: 0,
          avaliacao: 0.0,
          senha: senhaHash, // Armazena a senha criptografada
        },
      ])
      .select();

    if (error) throw error;

    res
      .status(201)
      .json({ message: "Profissional cadastrado com sucesso!", data });
  } catch (error) {
    console.error("Erro no cadastro:", error);
    // 🔴 GARANTIR QUE RETORNA O ERRO EM JSON PARA O REACT:
    res.status(500).json({
      error: error.message || "Erro interno ao cadastrar profissional.",
    });
  }
});

// ROTA DE LOGIN (Aceita Contacto ou E-mail)
app.post("/api/login", async (req, res) => {
  try {
    const { login, senha } = req.body || {};
    // 1. Validação simples
    if (!login || !senha) {
      return res
        .status(400)
        .json({ error: "Por favor, preencha o contacto/e-mail e a senha." });
    }

    const termo = login.trim();

    // 2. Busca o profissional por telefone ou email de forma mais segura
    const { data: profissionalPorTelefone, error: errorTelefone } =
      await supabase
        .from("profissionais")
        .select("*")
        .eq("telefone", termo)
        .maybeSingle();

    const { data: profissionalPorEmail, error: errorEmail } = await supabase
      .from("profissionais")
      .select("*")
      .eq("email", termo)
      .maybeSingle();

    const profissional = profissionalPorTelefone || profissionalPorEmail;

    if (errorTelefone || errorEmail || !profissional) {
      return res.status(404).json({
        error: "Contacto/e-mail incorreto.",
        tipo: "1", // Tipo 1: Profissional não encontrado
      });
    }

    // 3. Verifica se a senha existe e compara corretamente
    if (!profissional.senha) {
      return res
        .status(401)
        .json({
          error: "Este profissional não tem senha válida no sistema.",
          tipo: "2",
        });
    }

    let senhaValida = false;
    try {
      senhaValida = await bcrypt.compare(senha, profissional.senha);
    } catch (compareError) {
      console.error("Erro ao comparar senha do login:", compareError);
      return res
        .status(500)
        .json({ error: "Erro ao validar a senha. Contacte o suporte." });
    }

    if (!senhaValida) {
      return res.status(401).json({ error: "Senha incorreta.", tipo: "2" });
    }

    // 4. Remove a senha do objeto antes de enviar ao Front-end por segurança
    delete profissional.senha;

    // 5. Retorna sucesso e os dados do profissional
    res.status(200).json({
      message: "Login efetuado com sucesso!",
      profissional,
    });
  } catch (error) {
    console.error("Erro no login:", error);
    res.status(500).json({
      error:
        error.message || "Erro interno no servidor ao tentar realizar o login.",
    });
  }
});
// ROTA DE LOGIN (Aceita Contacto ou E-mail)
app.post("/api/login/verificar", async (req, res) => {
  try {
    const { email } = req.body || {};
    // 1. Validação simples
    if (!email) {
      return res
        .status(400)
        .json({ error: "Por favor, preencha o e-mail." });
    }

    const termo = email.trim();

    // 2. Busca o profissional por telefone ou email de forma mais segura

    const { data: profissionalPorEmail, error: errorEmail } = await supabase
      .from("profissionais")
      .select("*")
      .eq("email", termo)
      .maybeSingle();

    const profissional =  profissionalPorEmail;

    if (errorEmail || !profissional) {
      return res.status(404).json({
        error: "Nenhuma conta encontrada.",
        tipo: "0", // Tipo 1: Profissional não encontrado
      });
    }
    // 4. Remove a senha do objeto antes de enviar ao Front-end por segurança
    delete profissional.email;

    // 5. Retorna sucesso e os dados do profissional
    res.status(200).json({
      message: "Conta encontrada!"
    });
  } catch (error) {
    console.error("Erro no login:", error);
    res.status(500).json({
      error:
        error.message || "Erro interno no servidor ao tentar realizar o login.",
    });
  }
});

// ROTA: Atualizar perfil do profissional
app.put("/api/profissionais/:id", upload.single("foto"), async (req, res) => {
  try {
    const { id } = req.params;
    const {
      nome,
      status,
      telefone,
      whatsapp,
      email,
      profissao,
      localizacao,
      trabalho,
      domicilio,
    } = req.body;

    // 1. Busca os dados atuais do profissional para obter a URL da foto antiga
    const { data: profissionalAtual, error: erroBusca } = await supabase
      .from("profissionais")
      .select("foto")
      .eq("id", id)
      .single();

    if (erroBusca || !profissionalAtual) {
      return res.status(404).json({ error: "Profissional não encontrado." });
    }

    let novaFotoUrl = profissionalAtual.foto; // Mantém a foto atual por padrão

    // 2. Se uma nova foto foi enviada via Multer
    if (req.file) {
      // A) Apaga a foto antiga do Storage (se existir)
      const caminhoFotoAntiga = extrairCaminhoBucket(profissionalAtual.foto);
      if (caminhoFotoAntiga) {
        await supabase.storage
          .from("profissionais")
          .remove([caminhoFotoAntiga]);
      }

      // B) Faz o upload da nova foto
      const fileExt = req.file.originalname.split(".").pop();
      const fileName = `${Date.now()}_${Math.random().toString(36).substring(7)}.${fileExt}`;
      const filePath = `perfis/${fileName}`;

      const { error: uploadError } = await supabase.storage
        .from("profissionais")
        .upload(filePath, req.file.buffer, {
          contentType: req.file.mimetype,
          upsert: true,
        });

      if (uploadError) {
        console.error("Erro no upload da nova foto:", uploadError);
        return res.status(500).json({ error: "Falha ao guardar a nova foto." });
      }

      // C) Gera a URL pública da nova imagem
      const { data: urlData } = supabase.storage
        .from("profissionais")
        .getPublicUrl(filePath);

      novaFotoUrl = urlData.publicUrl;
    }

    // 3. Atualiza os dados na tabela 'profissionais'
    const { data: profissionalAtualizado, error: updateError } = await supabase
      .from("profissionais")
      .update({
        nome,
        status,
        telefone,
        whatsapp,
        email,
        profissao,
        localizacao,
        trabalho,
        domicilio,
        foto: novaFotoUrl,
      })
      .eq("id", id)
      .select();

    if (updateError) {
      console.error("Erro ao atualizar banco:", updateError);
      return res
        .status(500)
        .json({ error: "Erro ao guardar as alterações no perfil." });
    }

    // 4. Retorna os dados atualizados ao Front-end
    return res.status(200).json({
      message: "Perfil atualizado com sucesso!",
      profissional: profissionalAtualizado[0],
    });
  } catch (error) {
    console.error("Erro na atualização do perfil:", error);
    return res.status(500).json({ error: "Erro interno ao atualizar perfil." });
  }
});

// ----------------------------------------------------
// ROTA 1: Gerar Token e Enviar E-mail de Recuperação
// ----------------------------------------------------
app.post('/api/esquecisenha', async (req, res) => {
  const { email } = req.body;

  try {
    // 1. Procura o profissional no banco
    const { data: profissional, error } = await supabase
      .from('profissionais')
      .select('*')
      .eq('email', email)
      .single();

    if (error || !profissional) {
      return res.status(404).json({ error: 'E-mail não encontrado.' });
    }

    // 2. Gera um token aleatório e define expiração (30 minutos)
    const resetToken = crypto.randomBytes(32).toString('hex');
    const tokenExpira = new Date(Date.now() + 30 * 60 * 1000).toISOString();

    // 3. Guarda o token e expiração no banco de dados
    await supabase
      .from('profissionais')
      .update({ reset_token: resetToken, reset_expira: tokenExpira })
      .eq('id', profissional.id);

    // 4. Cria o link de redefinição
    const linkRedefinicao = `https://trabalhadorlivre.vercel.app/?token=${resetToken}&actualPage=redefinir-senha`;

    // 5. Conteúdo do E-mail
    const mailOptions = {
      from: '"Suporte Plataforma" <trabalhadorlivremz@gmail.com>',
      to: email,
      subject: 'Recuperação de Conta - Redefinir Senha',
      html: `
        <h3>Olá, ${profissional.nome}!</h3>
        <p>Recebemos um pedido para redefinir a palavra-passe da tua conta.</p>
        <p>Clica no botão abaixo para criar uma nova senha. Este link expira em 30 minutos:</p>
        <a href="${linkRedefinicao}" style="padding: 10px 20px; background: #2563eb; color: white; text-decoration: none; border-radius: 5px; display: inline-block;">Redefinir Minha Senha</a>
        <p>Se não pediste esta alteração, podes ignorar este e-mail.</p>
      `
    };

    await transporter.sendMail(mailOptions);
    return res.status(200).json({ message: 'E-mail de recuperação enviado com sucesso!' });

  } catch (err) {

    console.error('ERRO DETALHADO NO BACKEND:', err);
    return res.status(500).json({ error: 'Erro ao processar pedido de recuperação.' });
  }
});

// ----------------------------------------------------
// ROTA 2: Atualizar para a Nova Senha
// ----------------------------------------------------
app.post('/api/redefinir-senha', async (req, res) => {
  const { token, novaSenha } = req.body;

  try {
    // 1. Procura o profissional que possui este token
    const { data: profissional, error } = await supabase
      .from('profissionais')
      .select('*')
      .eq('reset_token', token)
      .single();

    if (error || !profissional) {
      return res.status(400).json({ error: 'Token inválido ou expirado.' });
    }

    // 2. Verifica se o token já expirou
    if (new Date() > new Date(profissional.reset_expira)) {
      return res.status(400).json({ error: 'O link de recuperação expirou. Pede um novo link.' });
    }

    // 3. Criptografa a nova senha
    const senhaHash = await bcrypt.hash(novaSenha, 10);

    // 4. Atualiza a senha no banco e limpa o token usado
    await supabase
      .from('profissionais')
      .update({
        senha: senhaHash,
        reset_token: null,
        reset_expira: null
      })
      .eq('id', profissional.id);

    return res.status(200).json({ message: 'Senha redefinida com sucesso! Já podes fazer login.' });

  } catch (err) {
    return res.status(500).json({ error: 'Erro ao redefinir palavra-passe.' });
  }
});





// Inicia o servidor na porta 5000
app.listen(5000, () => {
  console.log("Servidor rodando na porta 5000");
});
